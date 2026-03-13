use anyhow::{Context, Result, anyhow};
use fff_core::constraints::{apply_constraints, path_contains_segment};
use fff_core::file_picker::FilePicker;
use fff_core::grep::{GrepMode, GrepSearchOptions, grep_search, parse_grep_query};
use fff_core::types::FileItem;
use fff_core::{
    Constraint, FFFMode, FFFQuery, FuzzySearchOptions, PaginationArgs, QueryParser, SharedFrecency,
    SharedPicker,
};
use regex::bytes::{Regex as BytesRegex, RegexBuilder as BytesRegexBuilder};
use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::io::{self, BufRead, Write};
use std::sync::{Arc, RwLock};

const MAX_GREP_FILE_SIZE_BYTES: u64 = 10 * 1024 * 1024;
const MAX_LINE_MATCHES_PER_FILE: usize = 100;
const GREP_TIME_BUDGET_MS: u64 = 0;
const DEFAULT_COMBO_BOOST_MULTIPLIER: i32 = 100;
const DEFAULT_MIN_COMBO_COUNT: u32 = 3;
const RAW_CANDIDATE_LIMIT_MULTIPLIER: usize = 8;
const MIN_RAW_CANDIDATE_LIMIT: usize = 600;
const MAX_RAW_CANDIDATE_LIMIT: usize = 1500;
const FIRST_PASS_MAX_RESULTS_PER_FILE: usize = 2;
const FIRST_PASS_MAX_RESULTS_PER_BUCKET: usize = 24;
const LARGE_FILE_SIZE_BYTES: u64 = 256 * 1024;
const VERY_LARGE_FILE_SIZE_BYTES: u64 = 1024 * 1024;
const HEAVY_NOISE_PENALTY: i64 = 5_000;
const MEDIUM_NOISE_PENALTY: i64 = 1_000;
const LARGE_FILE_PENALTY: i64 = 200;
const VERY_LARGE_FILE_PENALTY: i64 = 500;
const NOISY_BASENAMES: &[&str] = &[
    "bun.lock",
    "bun.lockb",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "pnpm-lock.yaml",
    "pnpm-lock.yml",
    "yarn.lock",
    "cargo.lock",
    "gemfile.lock",
    "podfile.lock",
    "composer.lock",
    "poetry.lock",
    "uv.lock",
];
const NOISY_PATH_SEGMENTS: &[&str] = &[
    "dist",
    "build",
    "out",
    "coverage",
    ".next",
    ".nuxt",
    ".svelte-kit",
    "generated",
    "gen",
    "storybook-static",
];
const NOISY_SUFFIXES: &[&str] = &[".svg", ".map", ".snap", ".min.js", ".min.css"];

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum Request {
    Init {
        id: u64,
        roots: Vec<String>,
    },
    Search {
        id: u64,
        query: String,
        limit: usize,
        #[serde(rename = "currentFile")]
        current_file: Option<String>,
        #[serde(rename = "caseSensitive")]
        case_sensitive: bool,
        #[serde(rename = "regexEnabled")]
        regex_enabled: bool,
    },
    Rescan {
        id: u64,
    },
    Shutdown {
        id: u64,
    },
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum Response {
    Ready {
        id: u64,
    },
    Ack {
        id: u64,
    },
    Results {
        id: u64,
        results: Vec<SearchHit>,
        #[serde(rename = "indexedFileCount")]
        indexed_file_count: usize,
        #[serde(rename = "searchableFileCount")]
        searchable_file_count: usize,
        #[serde(rename = "skippedFileCount")]
        skipped_file_count: usize,
        #[serde(rename = "isScanning")]
        is_scanning: bool,
    },
    Error {
        id: Option<u64>,
        message: String,
    },
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum SearchHit {
    File {
        path: String,
        score: f64,
    },
    Line {
        path: String,
        score: f64,
        #[serde(rename = "lineNumber")]
        line_number: u64,
        column: usize,
        #[serde(rename = "lineText")]
        line_text: String,
    },
}

#[derive(Debug)]
struct RootState {
    picker: SharedPicker,
    frecency: SharedFrecency,
}

#[derive(Debug, Default)]
struct SearchPayload {
    results: Vec<SearchHit>,
    indexed_file_count: usize,
    searchable_file_count: usize,
    skipped_file_count: usize,
    is_scanning: bool,
}

#[derive(Debug, Default)]
struct App {
    roots: Vec<RootState>,
}

#[derive(Debug, Clone)]
struct FileCandidate {
    path: String,
    metadata: CandidateMetadata,
}

#[derive(Debug, Clone)]
struct LineCandidate {
    path: String,
    line_number: u64,
    column: usize,
    line_text: String,
    metadata: CandidateMetadata,
}

#[derive(Debug, Clone)]
enum MergedCandidate {
    File(FileCandidate),
    Line(LineCandidate),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CandidateKind {
    File,
    Line,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum CandidateSource {
    ExactFile,
    FuzzyFile,
    GrepLine,
}

#[derive(Debug, Clone)]
struct CandidateMetadata {
    relative_path: String,
    relative_path_lower: String,
    basename_lower: String,
    extension: Option<String>,
    size: u64,
    raw_rank: usize,
    source: CandidateSource,
}

#[derive(Debug)]
struct SearchQueryPlan<'a> {
    original_query: &'a str,
    parsed_grep_query: Option<FFFQuery<'a>>,
    match_text: String,
    normalized_match_text: String,
    path_like_query: bool,
    file_regex: Option<BytesRegex>,
}

#[derive(Debug, Default, Clone, Copy)]
struct NoisyFilePolicy;

impl<'a> SearchQueryPlan<'a> {
    fn build(query: &'a str, case_sensitive: bool, regex_enabled: bool) -> Result<Self> {
        let original_query = query.trim();
        let parsed_grep_query = parse_grep_query(original_query);
        let match_text = extract_match_text(original_query, parsed_grep_query.as_ref());
        let normalized_match_text = if case_sensitive {
            match_text.clone()
        } else {
            match_text.to_lowercase()
        };
        let path_like_query = if match_text.is_empty() {
            is_path_like_query(original_query)
        } else {
            is_path_like_query(&match_text)
        };
        let file_regex = build_file_regex(&match_text, case_sensitive, regex_enabled)?;

        Ok(Self {
            original_query,
            parsed_grep_query,
            match_text,
            normalized_match_text,
            path_like_query,
            file_regex,
        })
    }

    fn constraints(&self) -> &[Constraint<'a>] {
        self.parsed_grep_query
            .as_ref()
            .map(|query| query.constraints.as_slice())
            .unwrap_or(&[])
    }
}

impl NoisyFilePolicy {
    fn penalty(self, metadata: &CandidateMetadata) -> i64 {
        let mut penalty = 0;

        if NOISY_BASENAMES
            .iter()
            .any(|name| *name == metadata.basename_lower.as_str())
        {
            penalty += HEAVY_NOISE_PENALTY;
        }

        if NOISY_PATH_SEGMENTS
            .iter()
            .any(|segment| path_contains_segment(&metadata.relative_path_lower, segment))
        {
            penalty += MEDIUM_NOISE_PENALTY;
        }

        if NOISY_SUFFIXES.iter().any(|suffix| {
            metadata.basename_lower.ends_with(suffix)
                || matches!(
                    (metadata.extension.as_deref(), *suffix),
                    (Some("svg"), ".svg") | (Some("map"), ".map") | (Some("snap"), ".snap")
                )
        }) {
            penalty += MEDIUM_NOISE_PENALTY;
        }

        if metadata.size > VERY_LARGE_FILE_SIZE_BYTES {
            penalty += VERY_LARGE_FILE_PENALTY;
        } else if metadata.size > LARGE_FILE_SIZE_BYTES {
            penalty += LARGE_FILE_PENALTY;
        }

        penalty
    }
}

fn extract_match_text(query: &str, parsed_query: Option<&FFFQuery<'_>>) -> String {
    match parsed_query {
        Some(parsed_query) => parsed_query.grep_text(),
        None => {
            if query.starts_with('\\') && query.len() > 1 {
                let suffix = &query[1..];
                if parse_grep_query(suffix).is_some_and(|parsed| !parsed.constraints.is_empty()) {
                    suffix.to_string()
                } else {
                    query.to_string()
                }
            } else {
                query.to_string()
            }
        }
    }
}

fn raw_candidate_limit(limit: usize) -> usize {
    limit
        .saturating_mul(RAW_CANDIDATE_LIMIT_MULTIPLIER)
        .max(MIN_RAW_CANDIDATE_LIMIT)
        .min(MAX_RAW_CANDIDATE_LIMIT)
}

fn file_extension(file_name: &str) -> Option<String> {
    file_name
        .rsplit_once('.')
        .and_then(|(_, extension)| (!extension.is_empty()).then(|| extension.to_lowercase()))
}

fn build_candidate_metadata(
    file: &FileItem,
    raw_rank: usize,
    kind: CandidateKind,
) -> CandidateMetadata {
    CandidateMetadata {
        relative_path: file.relative_path.clone(),
        relative_path_lower: file.relative_path_lower.clone(),
        basename_lower: file.file_name_lower.clone(),
        extension: file_extension(&file.file_name),
        size: file.size,
        raw_rank,
        source: match kind {
            CandidateKind::File => CandidateSource::ExactFile,
            CandidateKind::Line => CandidateSource::GrepLine,
        },
    }
}

fn build_file_candidate_metadata(
    file: &FileItem,
    raw_rank: usize,
    source: CandidateSource,
) -> CandidateMetadata {
    let mut metadata = build_candidate_metadata(file, raw_rank, CandidateKind::File);
    metadata.source = source;
    metadata
}

fn scope_files<'a>(files: &'a [FileItem], constraints: &[Constraint<'_>]) -> Cow<'a, [FileItem]> {
    if constraints.is_empty() {
        return Cow::Borrowed(files);
    }

    match apply_constraints(files, constraints) {
        Some(filtered) => Cow::Owned(filtered.into_iter().cloned().collect()),
        None => Cow::Borrowed(files),
    }
}

impl App {
    fn initialize(&mut self, roots: Vec<String>) -> Result<()> {
        self.shutdown();

        let next_roots = roots
            .into_iter()
            .map(RootState::new)
            .collect::<Result<Vec<_>>>()?;
        self.roots = next_roots;
        Ok(())
    }

    fn search(
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

    fn rescan(&mut self) -> Result<()> {
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

    fn shutdown(&mut self) {
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

fn main() {
    debug_log("main: starting");
    if let Err(error) = run() {
        debug_log(&format!("main: exiting with error: {error:#}"));
        eprintln!("{error:#}");
        std::process::exit(1);
    }
    debug_log("main: clean exit");
}

fn run() -> Result<()> {
    debug_log("run: entered");
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut output = stdout.lock();
    let mut app = App::default();
    debug_log("run: stdio locked");

    for line in stdin.lock().lines() {
        debug_log("run: waiting for next line completed");
        let line = match line {
            Ok(line) if !line.trim().is_empty() => line,
            Ok(_) => continue,
            Err(error) => {
                debug_log(&format!("run: failed to read request: {error}"));
                write_response(
                    &mut output,
                    &Response::Error {
                        id: None,
                        message: format!("Failed to read request: {error}"),
                    },
                )?;
                continue;
            }
        };
        debug_log(&format!("run: received raw line: {line}"));

        let request = match serde_json::from_str::<Request>(&line) {
            Ok(request) => request,
            Err(error) => {
                debug_log(&format!("run: failed to parse request: {error}"));
                write_response(
                    &mut output,
                    &Response::Error {
                        id: None,
                        message: format!("Failed to parse request: {error}"),
                    },
                )?;
                continue;
            }
        };
        debug_log(&format!(
            "run: parsed request type: {}",
            request_type(&request)
        ));

        let shutdown_after_response = matches!(request, Request::Shutdown { .. });

        let response = match request {
            Request::Init { id, roots } => {
                debug_log(&format!("run: handling init id={id} roots={}", roots.len()));
                match app.initialize(roots) {
                    Ok(()) => Response::Ready { id },
                    Err(error) => Response::Error {
                        id: Some(id),
                        message: error.to_string(),
                    },
                }
            }
            Request::Search {
                id,
                query,
                limit,
                current_file,
                case_sensitive,
                regex_enabled,
            } => {
                debug_log(&format!(
                    "run: handling search id={id} query={query:?} limit={limit} case_sensitive={case_sensitive} regex_enabled={regex_enabled}"
                ));
                match app.search(
                    &query,
                    limit.max(1),
                    current_file.as_deref(),
                    case_sensitive,
                    regex_enabled,
                ) {
                    Ok(payload) => Response::Results {
                        id,
                        results: payload.results,
                        indexed_file_count: payload.indexed_file_count,
                        searchable_file_count: payload.searchable_file_count,
                        skipped_file_count: payload.skipped_file_count,
                        is_scanning: payload.is_scanning,
                    },
                    Err(error) => Response::Error {
                        id: Some(id),
                        message: error.to_string(),
                    },
                }
            }
            Request::Rescan { id } => {
                debug_log(&format!("run: handling rescan id={id}"));
                match app.rescan() {
                    Ok(()) => Response::Ack { id },
                    Err(error) => Response::Error {
                        id: Some(id),
                        message: error.to_string(),
                    },
                }
            }
            Request::Shutdown { id } => {
                debug_log(&format!("run: handling shutdown id={id}"));
                app.shutdown();
                Response::Ack { id }
            }
        };

        debug_log(&format!(
            "run: writing response type={}",
            response_type(&response)
        ));
        write_response(&mut output, &response)?;

        if shutdown_after_response {
            debug_log("run: shutdown requested, breaking loop");
            break;
        }
    }

    debug_log("run: input loop ended, shutting down app");
    app.shutdown();
    Ok(())
}

fn write_response(writer: &mut dyn Write, response: &Response) -> Result<()> {
    serde_json::to_writer(&mut *writer, response)?;
    writer.write_all(b"\n")?;
    writer.flush()?;
    Ok(())
}

fn debug_log(message: &str) {
    if std::env::var_os("MODAL_FIND_DEBUG_SIDECAR").is_some() {
        eprintln!("[modal-find/sidecar] {message}");
    }
}

fn request_type(request: &Request) -> &'static str {
    match request {
        Request::Init { .. } => "init",
        Request::Search { .. } => "search",
        Request::Rescan { .. } => "rescan",
        Request::Shutdown { .. } => "shutdown",
    }
}

fn response_type(response: &Response) -> &'static str {
    match response {
        Response::Ready { .. } => "ready",
        Response::Ack { .. } => "ack",
        Response::Results { .. } => "results",
        Response::Error { .. } => "error",
    }
}

fn grep_options(limit: usize, case_sensitive: bool, regex_enabled: bool) -> GrepSearchOptions {
    GrepSearchOptions {
        max_file_size: MAX_GREP_FILE_SIZE_BYTES,
        max_matches_per_file: MAX_LINE_MATCHES_PER_FILE,
        smart_case: !case_sensitive,
        file_offset: 0,
        page_limit: limit,
        mode: grep_mode(regex_enabled),
        time_budget_ms: GREP_TIME_BUDGET_MS,
        before_context: 0,
        after_context: 0,
        classify_definitions: false,
    }
}

fn grep_mode(regex_enabled: bool) -> GrepMode {
    if regex_enabled {
        GrepMode::Regex
    } else {
        GrepMode::PlainText
    }
}

fn is_path_like_query(query: &str) -> bool {
    query.contains('/')
        || query.contains('\\')
        || query.contains('.')
        || query.contains('_')
        || query.contains('-')
}

fn is_searchable(file: &FileItem) -> bool {
    !file.is_binary && file.size <= MAX_GREP_FILE_SIZE_BYTES
}

fn should_use_fuzzy_file_fallback(
    query: &str,
    line_candidate_count: usize,
    literal_file_candidate_count: usize,
    case_sensitive: bool,
    regex_enabled: bool,
) -> bool {
    query.is_empty()
        || (!case_sensitive
            && !regex_enabled
            && line_candidate_count == 0
            && literal_file_candidate_count == 0)
}

fn build_file_regex(
    query: &str,
    case_sensitive: bool,
    regex_enabled: bool,
) -> Result<Option<BytesRegex>> {
    if !regex_enabled || query.is_empty() {
        return Ok(None);
    }

    let case_insensitive = !case_sensitive && !query.chars().any(|c| c.is_uppercase());
    BytesRegexBuilder::new(query)
        .case_insensitive(case_insensitive)
        .multi_line(true)
        .unicode(false)
        .build()
        .map(Some)
        .map_err(|error| anyhow!("Invalid regex: {error}"))
}

fn collect_literal_file_candidates(
    files: &[FileItem],
    query: &str,
    case_sensitive: bool,
    base_raw_rank: usize,
) -> Vec<FileCandidate> {
    if query.is_empty() {
        return Vec::new();
    }

    let query_lower = (!case_sensitive).then(|| query.to_lowercase());
    let mut filename_matches: Vec<&FileItem> = Vec::new();
    let mut path_matches: Vec<&FileItem> = Vec::new();

    for file in files {
        let filename_matches_query = if case_sensitive {
            file.file_name.contains(query)
        } else {
            file.file_name_lower
                .contains(query_lower.as_deref().unwrap_or_default())
        };
        let path_matches_query = if case_sensitive {
            file.relative_path.contains(query)
        } else {
            file.relative_path_lower
                .contains(query_lower.as_deref().unwrap_or_default())
        };

        if filename_matches_query {
            filename_matches.push(file);
        } else if path_matches_query {
            path_matches.push(file);
        }
    }

    sort_file_items_by_path(&mut filename_matches);
    sort_file_items_by_path(&mut path_matches);

    filename_matches.extend(path_matches);
    filename_matches
        .into_iter()
        .enumerate()
        .map(|(index, file)| FileCandidate {
            path: file.path.to_string_lossy().into_owned(),
            metadata: build_file_candidate_metadata(
                file,
                base_raw_rank + index,
                CandidateSource::ExactFile,
            ),
        })
        .collect()
}

fn collect_scoped_file_candidates(files: &[FileItem], base_raw_rank: usize) -> Vec<FileCandidate> {
    let mut matches: Vec<&FileItem> = files.iter().collect();
    sort_file_items_by_path(&mut matches);

    matches
        .into_iter()
        .enumerate()
        .map(|(index, file)| FileCandidate {
            path: file.path.to_string_lossy().into_owned(),
            metadata: build_file_candidate_metadata(
                file,
                base_raw_rank + index,
                CandidateSource::ExactFile,
            ),
        })
        .collect()
}

fn collect_regex_file_candidates(
    files: &[FileItem],
    query: &BytesRegex,
    base_raw_rank: usize,
) -> Vec<FileCandidate> {
    let mut filename_matches: Vec<&FileItem> = Vec::new();
    let mut path_matches: Vec<&FileItem> = Vec::new();

    for file in files {
        if query.is_match(file.file_name.as_bytes()) {
            filename_matches.push(file);
        } else if query.is_match(file.relative_path.as_bytes()) {
            path_matches.push(file);
        }
    }

    sort_file_items_by_path(&mut filename_matches);
    sort_file_items_by_path(&mut path_matches);

    filename_matches.extend(path_matches);
    filename_matches
        .into_iter()
        .enumerate()
        .map(|(index, file)| FileCandidate {
            path: file.path.to_string_lossy().into_owned(),
            metadata: build_file_candidate_metadata(
                file,
                base_raw_rank + index,
                CandidateSource::ExactFile,
            ),
        })
        .collect()
}

fn sort_file_items_by_path(files: &mut Vec<&FileItem>) {
    files.sort_by(|left, right| {
        left.relative_path
            .len()
            .cmp(&right.relative_path.len())
            .then(left.relative_path_lower.cmp(&right.relative_path_lower))
    });
}

fn order_results(
    query: &str,
    path_like_query: bool,
    line_candidates: Vec<LineCandidate>,
    literal_file_candidates: Vec<FileCandidate>,
    fuzzy_file_candidates: Vec<FileCandidate>,
    limit: usize,
) -> Vec<SearchHit> {
    let policy = NoisyFilePolicy;
    let mut groups: Vec<Vec<MergedCandidate>> = Vec::new();

    if query.is_empty() || path_like_query {
        let mut file_candidates =
            combine_file_candidates(literal_file_candidates, fuzzy_file_candidates);
        sort_file_candidates(&mut file_candidates, policy);
        if file_candidates.is_empty() {
            let mut ranked_lines = line_candidates;
            sort_line_candidates(&mut ranked_lines, policy);
            groups.push(
                ranked_lines
                    .into_iter()
                    .map(MergedCandidate::Line)
                    .collect(),
            );
        } else {
            groups.push(
                file_candidates
                    .into_iter()
                    .map(MergedCandidate::File)
                    .collect(),
            );
        }
    } else {
        let mut ranked_lines = line_candidates;
        sort_line_candidates(&mut ranked_lines, policy);
        let mut exact_files = literal_file_candidates;
        sort_file_candidates(&mut exact_files, policy);

        groups.push(
            ranked_lines
                .into_iter()
                .map(MergedCandidate::Line)
                .collect(),
        );
        groups.push(exact_files.into_iter().map(MergedCandidate::File).collect());

        if groups.iter().all(|group| group.is_empty()) {
            let mut fallback_files = fuzzy_file_candidates;
            sort_file_candidates(&mut fallback_files, policy);
            groups.push(
                fallback_files
                    .into_iter()
                    .map(MergedCandidate::File)
                    .collect(),
            );
        }
    }

    let merged = select_diverse_candidates(groups, limit);

    let total = merged.len().max(1);
    merged
        .into_iter()
        .take(limit)
        .enumerate()
        .map(|(index, candidate)| {
            let score = (total - index) as f64;
            match candidate {
                MergedCandidate::File(candidate) => SearchHit::File {
                    path: candidate.path,
                    score,
                },
                MergedCandidate::Line(candidate) => SearchHit::Line {
                    path: candidate.path,
                    score,
                    line_number: candidate.line_number,
                    column: candidate.column,
                    line_text: candidate.line_text,
                },
            }
        })
        .collect()
}

fn combine_file_candidates(
    literal_file_candidates: Vec<FileCandidate>,
    fuzzy_file_candidates: Vec<FileCandidate>,
) -> Vec<FileCandidate> {
    let mut combined =
        Vec::with_capacity(literal_file_candidates.len() + fuzzy_file_candidates.len());
    let mut seen_paths = HashSet::new();

    for candidate in literal_file_candidates
        .into_iter()
        .chain(fuzzy_file_candidates.into_iter())
    {
        if seen_paths.insert(candidate.path.clone()) {
            combined.push(candidate);
        }
    }

    combined
}

fn sort_file_candidates(candidates: &mut [FileCandidate], policy: NoisyFilePolicy) {
    candidates.sort_by(|left, right| {
        left.metadata
            .source
            .cmp(&right.metadata.source)
            .then(
                adjusted_candidate_rank(&left.metadata, policy)
                    .cmp(&adjusted_candidate_rank(&right.metadata, policy)),
            )
            .then(left.metadata.raw_rank.cmp(&right.metadata.raw_rank))
            .then(
                left.metadata
                    .relative_path
                    .cmp(&right.metadata.relative_path),
            )
    });
}

fn sort_line_candidates(candidates: &mut [LineCandidate], policy: NoisyFilePolicy) {
    candidates.sort_by(|left, right| {
        adjusted_candidate_rank(&left.metadata, policy)
            .cmp(&adjusted_candidate_rank(&right.metadata, policy))
            .then(left.metadata.raw_rank.cmp(&right.metadata.raw_rank))
            .then(
                left.metadata
                    .relative_path
                    .cmp(&right.metadata.relative_path),
            )
            .then(left.line_number.cmp(&right.line_number))
            .then(left.column.cmp(&right.column))
    });
}

fn adjusted_candidate_rank(metadata: &CandidateMetadata, policy: NoisyFilePolicy) -> i64 {
    metadata.raw_rank as i64 + policy.penalty(metadata)
}

fn select_diverse_candidates(
    groups: Vec<Vec<MergedCandidate>>,
    limit: usize,
) -> Vec<MergedCandidate> {
    let mut selected = Vec::with_capacity(limit);
    let mut selected_keys = HashSet::new();
    let mut per_file_counts: HashMap<String, usize> = HashMap::new();
    let mut per_bucket_counts: HashMap<String, usize> = HashMap::new();

    for (max_per_file, max_per_bucket) in [
        (
            Some(FIRST_PASS_MAX_RESULTS_PER_FILE),
            Some(FIRST_PASS_MAX_RESULTS_PER_BUCKET),
        ),
        (None, None),
    ] {
        if selected.len() >= limit {
            break;
        }

        for group in &groups {
            if selected.len() >= limit {
                break;
            }

            for candidate in group {
                if selected.len() >= limit {
                    break;
                }

                let candidate_key = merged_candidate_key(candidate);
                if selected_keys.contains(&candidate_key) {
                    continue;
                }

                let path = merged_candidate_path(candidate);
                if let Some(max_per_file) = max_per_file
                    && per_file_counts.get(path).copied().unwrap_or_default() >= max_per_file
                {
                    continue;
                }
                let bucket = merged_candidate_bucket(candidate);
                if let Some(max_per_bucket) = max_per_bucket
                    && per_bucket_counts.get(&bucket).copied().unwrap_or_default() >= max_per_bucket
                {
                    continue;
                }

                selected_keys.insert(candidate_key);
                *per_file_counts.entry(path.to_string()).or_default() += 1;
                *per_bucket_counts.entry(bucket).or_default() += 1;
                selected.push(candidate.clone());
            }
        }
    }

    selected
}

fn merged_candidate_path(candidate: &MergedCandidate) -> &str {
    match candidate {
        MergedCandidate::File(candidate) => &candidate.path,
        MergedCandidate::Line(candidate) => &candidate.path,
    }
}

fn merged_candidate_bucket(candidate: &MergedCandidate) -> String {
    let relative_path = match candidate {
        MergedCandidate::File(candidate) => candidate.metadata.relative_path.as_str(),
        MergedCandidate::Line(candidate) => candidate.metadata.relative_path.as_str(),
    };

    match relative_path.split_once('/') {
        Some((top_level, _)) => top_level.to_string(),
        None => "<root>".to_string(),
    }
}

fn merged_candidate_key(candidate: &MergedCandidate) -> String {
    match candidate {
        MergedCandidate::File(candidate) => format!("file:{}", candidate.path),
        MergedCandidate::Line(candidate) => format!(
            "line:{}:{}:{}",
            candidate.path, candidate.line_number, candidate.column
        ),
    }
}

fn byte_column_to_utf16_column(line: &str, byte_column: usize) -> usize {
    let mut safe_boundary = byte_column.min(line.len());
    while safe_boundary > 0 && !line.is_char_boundary(safe_boundary) {
        safe_boundary -= 1;
    }

    line[..safe_boundary].encode_utf16().count() + 1
}

#[cfg(test)]
mod tests {
    use super::{
        CandidateKind, CandidateSource, FileCandidate, LineCandidate, NoisyFilePolicy, Request,
        Response, SearchHit, SearchQueryPlan, build_candidate_metadata,
        build_file_candidate_metadata, build_file_regex, collect_literal_file_candidates,
        collect_regex_file_candidates, collect_scoped_file_candidates, is_path_like_query,
        order_results, scope_files, should_use_fuzzy_file_fallback,
    };
    use fff_core::Constraint;
    use fff_core::types::FileItem;
    use std::path::{Path, PathBuf};

    fn test_file_item(relative_path: &str, size: u64) -> FileItem {
        let file_name = Path::new(relative_path)
            .file_name()
            .expect("test file should have a basename")
            .to_string_lossy()
            .into_owned();

        FileItem::new_raw(
            PathBuf::from(format!("/tmp/{relative_path}")),
            relative_path.into(),
            file_name,
            size,
            0,
            None,
            false,
        )
    }

    fn test_file_candidate(
        relative_path: &str,
        raw_rank: usize,
        source: CandidateSource,
    ) -> FileCandidate {
        let file = test_file_item(relative_path, 128);
        FileCandidate {
            path: file.path.to_string_lossy().into_owned(),
            metadata: build_file_candidate_metadata(&file, raw_rank, source),
        }
    }

    fn test_line_candidate(
        relative_path: &str,
        line_number: u64,
        column: usize,
        raw_rank: usize,
        line_text: &str,
    ) -> LineCandidate {
        let file = test_file_item(relative_path, 128);
        LineCandidate {
            path: file.path.to_string_lossy().into_owned(),
            line_number,
            column,
            line_text: line_text.into(),
            metadata: build_candidate_metadata(&file, raw_rank, CandidateKind::Line),
        }
    }

    #[test]
    fn orders_line_results_before_file_results_for_symbol_queries() {
        let results = order_results(
            "TestClient",
            false,
            vec![test_line_candidate("src/c.ts", 12, 4, 0, "match")],
            vec![
                test_file_candidate("src/a.ts", 0, CandidateSource::ExactFile),
                test_file_candidate("src/b.ts", 1, CandidateSource::ExactFile),
            ],
            vec![test_file_candidate(
                "src/fuzzy.ts",
                0,
                CandidateSource::FuzzyFile,
            )],
            3,
        );

        assert_eq!(results.len(), 3);
        assert!(matches!(results[0], super::SearchHit::Line { .. }));
        assert!(matches!(results[1], super::SearchHit::File { .. }));
        assert!(matches!(results[2], super::SearchHit::File { .. }));
    }

    #[test]
    fn uses_fuzzy_file_fallback_only_when_no_better_results_exist() {
        let results = order_results(
            "TestClient",
            false,
            Vec::new(),
            vec![test_file_candidate(
                "src/literal.ts",
                0,
                CandidateSource::ExactFile,
            )],
            vec![test_file_candidate(
                "src/fuzzy.ts",
                0,
                CandidateSource::FuzzyFile,
            )],
            5,
        );

        assert_eq!(results.len(), 1);
        match &results[0] {
            SearchHit::File { path, .. } => assert_eq!(path, "/tmp/src/literal.ts"),
            other => panic!("unexpected result: {other:?}"),
        }
    }

    #[test]
    fn disables_fuzzy_file_fallback_when_case_sensitive() {
        assert!(!should_use_fuzzy_file_fallback(
            "TestClient",
            0,
            0,
            true,
            false,
        ));
        assert!(should_use_fuzzy_file_fallback("", 0, 0, true, false));
    }

    #[test]
    fn disables_fuzzy_file_fallback_when_regex_enabled() {
        assert!(!should_use_fuzzy_file_fallback(
            "test.*client",
            0,
            0,
            false,
            true,
        ));
    }

    #[test]
    fn disables_fuzzy_file_fallback_for_path_like_query_when_exact_matches_exist() {
        assert!(!should_use_fuzzy_file_fallback(
            "MessageV2.TextPart",
            1,
            0,
            false,
            false,
        ));
        assert!(!should_use_fuzzy_file_fallback(
            "MessageV2.TextPart",
            0,
            1,
            false,
            false,
        ));
        assert!(should_use_fuzzy_file_fallback(
            "MessageV2.TextPart",
            0,
            0,
            false,
            false,
        ));
    }

    #[test]
    fn constraint_only_queries_do_not_use_empty_query_fallback_rules() {
        assert!(!should_use_fuzzy_file_fallback("*.yml", 0, 1, false, false));
    }

    #[test]
    fn detects_path_like_queries() {
        assert!(is_path_like_query("src/chat"));
        assert!(is_path_like_query("ChatWindow.tsx"));
        assert!(!is_path_like_query("TestClient"));
    }

    #[test]
    fn search_query_plan_extracts_constraints_and_match_text() {
        let plan = SearchQueryPlan::build("v2 *.yml", false, false).expect("plan should build");

        assert_eq!(plan.match_text, "v2");
        assert_eq!(plan.normalized_match_text, "v2");
        assert_eq!(plan.constraints().len(), 1);
        assert!(matches!(
            plan.constraints()[0],
            Constraint::Extension("yml")
        ));
    }

    #[test]
    fn literal_file_candidates_prefer_filename_matches() {
        let files = vec![
            test_file_item("src/deep/TestClientService.ts", 100),
            test_file_item("src/features/client/index.ts", 100),
        ];

        let candidates = collect_literal_file_candidates(&files, "testclient", false, 0);
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].path, "/tmp/src/deep/TestClientService.ts");
    }

    #[test]
    fn case_sensitive_literal_file_candidates_require_exact_case() {
        let files = vec![test_file_item("src/deep/TestClientService.ts", 100)];

        assert!(collect_literal_file_candidates(&files, "testclient", true, 0).is_empty());
        assert_eq!(
            collect_literal_file_candidates(&files, "TestClient", true, 0).len(),
            1
        );
    }

    #[test]
    fn stripped_match_text_respects_file_constraints_for_exact_file_matches() {
        let plan = SearchQueryPlan::build("setup *.yml", false, false).expect("plan should build");
        let files = vec![
            test_file_item(".github/actions/setup-bun/action.yml", 100),
            test_file_item(".github/actions/setup-bun/action.ts", 100),
        ];
        let scoped_files = scope_files(&files, plan.constraints());

        let candidates =
            collect_literal_file_candidates(scoped_files.as_ref(), &plan.match_text, false, 0);

        assert_eq!(candidates.len(), 1);
        assert_eq!(
            candidates[0].path,
            "/tmp/.github/actions/setup-bun/action.yml"
        );
    }

    #[test]
    fn constraint_only_queries_collect_scoped_files() {
        let plan = SearchQueryPlan::build("*.yml", false, false).expect("plan should build");
        let files = vec![
            test_file_item(".github/actions/setup-bun/action.yml", 100),
            test_file_item(".github/workflows/publish.yml", 100),
            test_file_item("bun.lock", 100),
        ];
        let scoped_files = scope_files(&files, plan.constraints());
        let candidates = collect_scoped_file_candidates(scoped_files.as_ref(), 0);

        assert_eq!(candidates.len(), 2);
        assert_eq!(candidates[0].path, "/tmp/.github/workflows/publish.yml");
        assert_eq!(
            candidates[1].path,
            "/tmp/.github/actions/setup-bun/action.yml"
        );
    }

    #[test]
    fn literal_path_matches_stay_ahead_of_line_results_for_path_like_queries() {
        let results = order_results(
            "MessageV2.TextPart",
            true,
            vec![test_line_candidate(
                "src/line.ts",
                8,
                3,
                0,
                "MessageV2.TextPart",
            )],
            vec![test_file_candidate(
                "src/MessageV2.TextPart.ts",
                0,
                CandidateSource::ExactFile,
            )],
            vec![test_file_candidate(
                "src/MessageV2TextPart.ts",
                0,
                CandidateSource::FuzzyFile,
            )],
            5,
        );

        assert_eq!(results.len(), 2);
        match &results[0] {
            SearchHit::File { path, .. } => {
                assert_eq!(path, "/tmp/src/MessageV2.TextPart.ts")
            }
            other => panic!("unexpected result: {other:?}"),
        }
        match &results[1] {
            SearchHit::File { path, .. } => {
                assert_eq!(path, "/tmp/src/MessageV2TextPart.ts")
            }
            other => panic!("unexpected result: {other:?}"),
        }
    }

    #[test]
    fn regex_file_candidates_prefer_filename_matches() {
        let files = vec![
            test_file_item("src/deep/TestClientService.ts", 100),
            test_file_item("src/features/client/index.ts", 100),
        ];

        let regex = build_file_regex("TestClient.*", false, true)
            .expect("regex should compile")
            .expect("regex should be present");
        let candidates = collect_regex_file_candidates(&files, &regex, 0);
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].path, "/tmp/src/deep/TestClientService.ts");
    }

    #[test]
    fn noisy_file_policy_penalizes_lockfiles_generated_paths_and_suffixes() {
        let policy = NoisyFilePolicy;
        let normal_file = test_file_item("src/lib.rs", 128);
        let lockfile = test_file_item("bun.lock", 128);
        let generated_svg = test_file_item("dist/assets/logo.svg", 128);
        let large_generated_map = test_file_item("build/app.min.js.map", 2 * 1024 * 1024);

        let normal_penalty = policy.penalty(&build_candidate_metadata(
            &normal_file,
            0,
            CandidateKind::Line,
        ));
        let lockfile_penalty =
            policy.penalty(&build_candidate_metadata(&lockfile, 0, CandidateKind::Line));
        let generated_svg_penalty = policy.penalty(&build_candidate_metadata(
            &generated_svg,
            0,
            CandidateKind::Line,
        ));
        let large_generated_map_penalty = policy.penalty(&build_candidate_metadata(
            &large_generated_map,
            0,
            CandidateKind::Line,
        ));

        assert_eq!(normal_penalty, 0);
        assert!(lockfile_penalty > generated_svg_penalty);
        assert!(generated_svg_penalty >= 2_000);
        assert!(large_generated_map_penalty > generated_svg_penalty);
    }

    #[test]
    fn ranking_demotes_lockfiles_and_keeps_yaml_results_visible() {
        let mut line_candidates = vec![test_line_candidate(
            ".github/actions/setup-bun/action.yml",
            4,
            1,
            0,
            "uses: oven-sh/setup-bun@v2",
        )];

        for raw_rank in 1..=120usize {
            line_candidates.push(test_line_candidate(
                "bun.lock",
                raw_rank as u64,
                1,
                raw_rank,
                "v2",
            ));
        }

        line_candidates.push(test_line_candidate(
            ".github/workflows/publish.yml",
            12,
            1,
            121,
            "version: v2",
        ));
        line_candidates.push(test_line_candidate(
            ".github/workflows/publish.yml",
            18,
            1,
            122,
            "tag: v2",
        ));
        line_candidates.push(test_line_candidate(
            ".github/actions/setup-git-committer/action.yml",
            9,
            1,
            123,
            "uses: committer@v2",
        ));

        let results = order_results("v2", false, line_candidates, Vec::new(), Vec::new(), 80);
        let paths: Vec<&str> = results
            .iter()
            .map(|result| match result {
                SearchHit::File { path, .. } | SearchHit::Line { path, .. } => path.as_str(),
            })
            .collect();

        assert!(paths.contains(&"/tmp/.github/actions/setup-bun/action.yml"));
        assert!(paths.contains(&"/tmp/.github/workflows/publish.yml"));
        assert!(paths.contains(&"/tmp/.github/actions/setup-git-committer/action.yml"));
        let first_bun_lock = paths
            .iter()
            .position(|path| *path == "/tmp/bun.lock")
            .expect("bun.lock should still be present");
        let first_publish = paths
            .iter()
            .position(|path| *path == "/tmp/.github/workflows/publish.yml")
            .expect("publish.yml should be present");
        assert!(first_publish < first_bun_lock);
    }

    #[test]
    fn ranking_limits_dominant_top_level_buckets_in_first_pass() {
        let mut line_candidates = Vec::new();

        for raw_rank in 0..40usize {
            let relative_path = format!("packages/app/src/file-{raw_rank}.ts");
            line_candidates.push(test_line_candidate(
                relative_path.as_str(),
                1,
                1,
                raw_rank,
                "v2",
            ));
        }

        line_candidates.push(test_line_candidate(
            ".github/workflows/publish.yml",
            1,
            1,
            40,
            "v2",
        ));

        let results = order_results("v2", false, line_candidates, Vec::new(), Vec::new(), 25);

        assert!(results.iter().any(|result| matches!(
            result,
            SearchHit::Line { path, .. } if path == "/tmp/.github/workflows/publish.yml"
        )));
    }

    #[test]
    fn serializes_results_in_camel_case() {
        let response = Response::Results {
            id: 1,
            results: vec![SearchHit::Line {
                path: "src/main.ts".into(),
                score: 3.0,
                line_number: 14,
                column: 2,
                line_text: "const value = 1".into(),
            }],
            indexed_file_count: 10,
            searchable_file_count: 8,
            skipped_file_count: 2,
            is_scanning: false,
        };

        let json = serde_json::to_value(response).expect("response should serialize");
        assert_eq!(json["type"], "results");
        assert_eq!(json["indexedFileCount"], 10);
        assert_eq!(json["searchableFileCount"], 8);
        assert_eq!(json["skippedFileCount"], 2);
        assert_eq!(json["isScanning"], false);
        assert_eq!(json["results"][0]["lineNumber"], 14);
        assert_eq!(json["results"][0]["lineText"], "const value = 1");
    }

    #[test]
    fn parses_current_file_in_camel_case() {
        let request = serde_json::from_str::<Request>(
            r#"{"id":1,"type":"search","query":"abc","limit":20,"currentFile":"/tmp/x.ts","caseSensitive":true,"regexEnabled":true}"#,
        )
        .expect("request should parse");

        match request {
            Request::Search {
                current_file,
                case_sensitive,
                regex_enabled,
                ..
            } => {
                assert_eq!(current_file.as_deref(), Some("/tmp/x.ts"));
                assert!(case_sensitive);
                assert!(regex_enabled);
            }
            other => panic!("unexpected request: {other:?}"),
        }
    }
}
