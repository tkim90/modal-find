use anyhow::{Context, Result, anyhow};
use fff_core::file_picker::FilePicker;
use fff_core::grep::grep_search;
use fff_core::{FFFMode, FuzzySearchOptions, PaginationArgs, QueryParser, SharedFrecency, SharedPicker};
use std::sync::{Arc, RwLock};

use crate::candidates::{
    CandidateKind, CandidateSource, FileCandidate, LineCandidate,
    build_candidate_metadata, build_file_candidate_metadata,
    collect_literal_file_candidates, collect_regex_file_candidates, collect_scoped_file_candidates,
};
use crate::helpers::{
    DEFAULT_COMBO_BOOST_MULTIPLIER, DEFAULT_MIN_COMBO_COUNT,
    byte_column_to_utf16_column, grep_options, is_searchable, raw_candidate_limit,
    should_use_fuzzy_file_fallback,
};
use crate::protocol::SearchHit;
use crate::query::{SearchQueryPlan, scope_files};
use crate::ranking::order_results;

#[derive(Debug)]
pub struct RootState {
    picker: SharedPicker,
    frecency: SharedFrecency,
}

#[derive(Debug, Default)]
pub struct SearchPayload {
    pub results: Vec<SearchHit>,
    pub indexed_file_count: usize,
    pub searchable_file_count: usize,
    pub skipped_file_count: usize,
    pub is_scanning: bool,
}

#[derive(Debug, Default)]
pub struct App {
    roots: Vec<RootState>,
}

impl App {
    pub fn initialize(&mut self, roots: Vec<String>) -> Result<()> {
        self.shutdown();

        let next_roots = roots
            .into_iter()
            .map(RootState::new)
            .collect::<Result<Vec<_>>>()?;
        self.roots = next_roots;
        Ok(())
    }

    pub fn search(
        &self,
        query: &str,
        limit: usize,
        current_file: Option<&str>,
        case_sensitive: bool,
        regex_enabled: bool,
    ) -> Result<SearchPayload> {
        if self.roots.is_empty() {
            return Err(anyhow!("fff sidecar is not initialized"));
        }

        let plan = SearchQueryPlan::build(query, case_sensitive, regex_enabled)?;
        let raw_limit = raw_candidate_limit(limit);
        let mut payload = SearchPayload::default();
        let mut line_candidates = Vec::new();
        let mut literal_file_candidates = Vec::new();
        let mut fuzzy_file_candidates = Vec::new();

        for root in &self.roots {
            let picker_guard = root
                .picker
                .read()
                .map_err(|_| anyhow!("Failed to acquire file picker lock"))?;
            let picker = picker_guard
                .as_ref()
                .context("File picker not initialized for workspace root")?;
            let files = picker.get_files();

            payload.indexed_file_count += files.len();
            payload.searchable_file_count +=
                files.iter().filter(|file| is_searchable(file)).count();
            payload.is_scanning |= picker.is_scan_active();

            let scoped_files = scope_files(files, plan.constraints());
            let scoped_files = scoped_files.as_ref();

            literal_file_candidates.extend(
                if plan.match_text.is_empty() && !plan.constraints().is_empty() {
                    collect_scoped_file_candidates(scoped_files, literal_file_candidates.len())
                } else if let Some(file_regex) = plan.file_regex.as_ref() {
                    collect_regex_file_candidates(
                        scoped_files,
                        file_regex,
                        literal_file_candidates.len(),
                    )
                } else {
                    collect_literal_file_candidates(
                        scoped_files,
                        &plan.match_text,
                        case_sensitive,
                        literal_file_candidates.len(),
                    )
                },
            );

            if !plan.match_text.is_empty() {
                let grep_results = grep_search(
                    scoped_files,
                    &plan.normalized_match_text,
                    None,
                    &grep_options(raw_limit, case_sensitive, regex_enabled),
                );

                for grep_match in grep_results.matches {
                    let file = grep_results.files[grep_match.file_index];
                    line_candidates.push(LineCandidate {
                        path: file.path.to_string_lossy().into_owned(),
                        line_number: grep_match.line_number,
                        column: byte_column_to_utf16_column(
                            &grep_match.line_content,
                            grep_match.col,
                        ),
                        line_text: grep_match.line_content,
                        metadata: build_candidate_metadata(
                            file,
                            line_candidates.len(),
                            CandidateKind::Line,
                        ),
                    });
                }
            }

            if should_use_fuzzy_file_fallback(
                plan.original_query,
                line_candidates.len(),
                literal_file_candidates.len(),
                case_sensitive,
                regex_enabled,
            ) {
                let parsed_query = QueryParser::default().parse(plan.original_query);
                let file_results = FilePicker::fuzzy_search(
                    scoped_files,
                    plan.original_query,
                    parsed_query,
                    FuzzySearchOptions {
                        max_threads: 0,
                        current_file,
                        project_path: Some(picker.base_path()),
                        last_same_query_match: None,
                        combo_boost_score_multiplier: DEFAULT_COMBO_BOOST_MULTIPLIER,
                        min_combo_count: DEFAULT_MIN_COMBO_COUNT,
                        pagination: PaginationArgs {
                            offset: 0,
                            limit: raw_limit,
                        },
                    },
                );

                let base_raw_rank = fuzzy_file_candidates.len();
                fuzzy_file_candidates.extend(file_results.items.into_iter().enumerate().map(
                    |(index, item)| FileCandidate {
                        path: item.path.to_string_lossy().into_owned(),
                        metadata: build_file_candidate_metadata(
                            item,
                            base_raw_rank + index,
                            CandidateSource::FuzzyFile,
                        ),
                    },
                ));
            }
        }

        payload.skipped_file_count = payload
            .indexed_file_count
            .saturating_sub(payload.searchable_file_count);
        payload.results = order_results(
            &plan.match_text,
            plan.path_like_query,
            line_candidates,
            literal_file_candidates,
            fuzzy_file_candidates,
            limit,
        );

        Ok(payload)
    }

    pub fn rescan(&mut self) -> Result<()> {
        for root in &mut self.roots {
            let mut picker_guard = root
                .picker
                .write()
                .map_err(|_| anyhow!("Failed to acquire file picker lock"))?;
            let picker = picker_guard
                .as_mut()
                .context("File picker not initialized for workspace root")?;
            picker
                .trigger_rescan(&root.frecency)
                .context("Failed to trigger fff rescan")?;
        }

        Ok(())
    }

    pub fn shutdown(&mut self) {
        for root in &mut self.roots {
            if let Ok(mut picker_guard) = root.picker.write()
                && let Some(mut picker) = picker_guard.take()
            {
                picker.stop_background_monitor();
            }

            if let Ok(mut frecency_guard) = root.frecency.write() {
                *frecency_guard = None;
            }
        }

        self.roots.clear();
    }
}

impl RootState {
    fn new(root: String) -> Result<Self> {
        let picker: SharedPicker = Arc::new(RwLock::new(None));
        let frecency: SharedFrecency = Arc::new(RwLock::new(None));

        FilePicker::new_with_shared_state(
            root.clone(),
            false,
            FFFMode::Neovim,
            Arc::clone(&picker),
            Arc::clone(&frecency),
        )
        .with_context(|| format!("Failed to initialize fff for workspace root {root}"))?;

        Ok(Self { picker, frecency })
    }
}
