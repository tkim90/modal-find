use anyhow::{Context, Result, anyhow};
use fff_core::file_picker::FilePicker;
use fff_core::grep::{GrepMode, GrepSearchOptions, grep_search, parse_grep_query};
use fff_core::types::FileItem;
use fff_core::{
    FFFMode, FuzzySearchOptions, PaginationArgs, QueryParser, SharedFrecency, SharedPicker,
};
use regex::bytes::{Regex as BytesRegex, RegexBuilder as BytesRegexBuilder};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::io::{self, BufRead, Write};
use std::sync::{Arc, RwLock};

const MAX_GREP_FILE_SIZE_BYTES: u64 = 10 * 1024 * 1024;
const MAX_LINE_MATCHES_PER_FILE: usize = 100;
const GREP_TIME_BUDGET_MS: u64 = 0;
const DEFAULT_COMBO_BOOST_MULTIPLIER: i32 = 100;
const DEFAULT_MIN_COMBO_COUNT: u32 = 3;

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

#[derive(Debug)]
struct FileCandidate {
    path: String,
}

#[derive(Debug)]
struct LineCandidate {
    path: String,
    line_number: u64,
    column: usize,
    line_text: String,
}

#[derive(Debug)]
enum MergedCandidate {
    File(FileCandidate),
    Line(LineCandidate),
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

        let mut payload = SearchPayload::default();
        let mut line_candidates = Vec::new();
        let mut literal_file_candidates = Vec::new();
        let mut fuzzy_file_candidates = Vec::new();
        let query_trimmed = query.trim();
        let path_like_query = is_path_like_query(query_trimmed);
        let file_regex = build_file_regex(query, query_trimmed, case_sensitive, regex_enabled)?;

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

            literal_file_candidates.extend(if let Some(file_regex) = file_regex.as_ref() {
                collect_regex_file_candidates(files, file_regex)
            } else {
                collect_literal_file_candidates(files, query_trimmed, case_sensitive)
            });

            if !query_trimmed.is_empty() {
                let grep_query_str = if case_sensitive {
                    query.to_string()
                } else {
                    query.to_lowercase()
                };
                let grep_query = parse_grep_query(&grep_query_str);
                let grep_results = grep_search(
                    files,
                    &grep_query_str,
                    grep_query.as_ref(),
                    &grep_options(limit, case_sensitive, regex_enabled),
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
                    });
                }
            }

            if should_use_fuzzy_file_fallback(
                query_trimmed,
                line_candidates.len(),
                literal_file_candidates.len(),
                case_sensitive,
                regex_enabled,
            ) {
                let parsed_query = QueryParser::default().parse(query);
                let file_results = FilePicker::fuzzy_search(
                    files,
                    query,
                    parsed_query,
                    FuzzySearchOptions {
                        max_threads: 0,
                        current_file,
                        project_path: Some(picker.base_path()),
                        last_same_query_match: None,
                        combo_boost_score_multiplier: DEFAULT_COMBO_BOOST_MULTIPLIER,
                        min_combo_count: DEFAULT_MIN_COMBO_COUNT,
                        pagination: PaginationArgs { offset: 0, limit },
                    },
                );

                fuzzy_file_candidates.extend(file_results.items.into_iter().map(|item| {
                    FileCandidate {
                        path: item.path.to_string_lossy().into_owned(),
                    }
                }));
            }
        }

        payload.skipped_file_count = payload
            .indexed_file_count
            .saturating_sub(payload.searchable_file_count);
        payload.results = order_results(
            query_trimmed,
            path_like_query,
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
        debug_log(&format!("run: parsed request type: {}", request_type(&request)));

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

        debug_log(&format!("run: writing response type={}", response_type(&response)));
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
    query_trimmed: &str,
    case_sensitive: bool,
    regex_enabled: bool,
) -> Result<Option<BytesRegex>> {
    if !regex_enabled || query_trimmed.is_empty() {
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
) -> Vec<FileCandidate> {
    if query.is_empty() {
        return Vec::new();
    }

    let query_lower = (!case_sensitive).then(|| query.to_lowercase());
    let mut filename_matches = Vec::new();
    let mut path_matches = Vec::new();

    for file in files {
        let candidate = FileCandidate {
            path: file.path.to_string_lossy().into_owned(),
        };

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
            filename_matches.push(candidate);
        } else if path_matches_query {
            path_matches.push(candidate);
        }
    }

    filename_matches.sort_by(|left, right| {
        left.path
            .len()
            .cmp(&right.path.len())
            .then(left.path.cmp(&right.path))
    });
    path_matches.sort_by(|left, right| {
        left.path
            .len()
            .cmp(&right.path.len())
            .then(left.path.cmp(&right.path))
    });

    filename_matches.extend(path_matches);
    filename_matches
}

fn collect_regex_file_candidates(files: &[FileItem], query: &BytesRegex) -> Vec<FileCandidate> {
    let mut filename_matches = Vec::new();
    let mut path_matches = Vec::new();

    for file in files {
        let candidate = FileCandidate {
            path: file.path.to_string_lossy().into_owned(),
        };

        if query.is_match(file.file_name.as_bytes()) {
            filename_matches.push(candidate);
        } else if query.is_match(file.relative_path.as_bytes()) {
            path_matches.push(candidate);
        }
    }

    filename_matches.sort_by(|left, right| {
        left.path
            .len()
            .cmp(&right.path.len())
            .then(left.path.cmp(&right.path))
    });
    path_matches.sort_by(|left, right| {
        left.path
            .len()
            .cmp(&right.path.len())
            .then(left.path.cmp(&right.path))
    });

    filename_matches.extend(path_matches);
    filename_matches
}

fn order_results(
    query: &str,
    path_like_query: bool,
    line_candidates: Vec<LineCandidate>,
    literal_file_candidates: Vec<FileCandidate>,
    fuzzy_file_candidates: Vec<FileCandidate>,
    limit: usize,
) -> Vec<SearchHit> {
    let mut merged = Vec::with_capacity(limit);
    let mut seen_file_paths = HashSet::new();

    if query.is_empty() || path_like_query {
        push_file_candidates(&mut merged, &mut seen_file_paths, literal_file_candidates);
        push_file_candidates(&mut merged, &mut seen_file_paths, fuzzy_file_candidates);
        if merged.is_empty() {
            merged.extend(line_candidates.into_iter().map(MergedCandidate::Line));
        }
    } else {
        merged.extend(line_candidates.into_iter().map(MergedCandidate::Line));
        push_file_candidates(&mut merged, &mut seen_file_paths, literal_file_candidates);
        if merged.is_empty() {
            push_file_candidates(&mut merged, &mut seen_file_paths, fuzzy_file_candidates);
        }
    }

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

fn push_file_candidates(
    merged: &mut Vec<MergedCandidate>,
    seen_file_paths: &mut HashSet<String>,
    candidates: Vec<FileCandidate>,
) {
    for candidate in candidates {
        if seen_file_paths.insert(candidate.path.clone()) {
            merged.push(MergedCandidate::File(candidate));
        }
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
        FileCandidate, LineCandidate, Request, Response, SearchHit, build_file_regex,
        collect_literal_file_candidates, collect_regex_file_candidates, is_path_like_query,
        order_results, should_use_fuzzy_file_fallback,
    };
    use fff_core::types::FileItem;
    use std::path::PathBuf;

    #[test]
    fn orders_line_results_before_file_results_for_symbol_queries() {
        let results = order_results(
            "TestClient",
            false,
            vec![LineCandidate {
                path: "c.ts".into(),
                line_number: 12,
                column: 4,
                line_text: "match".into(),
            }],
            vec![
                FileCandidate {
                    path: "a.ts".into(),
                },
                FileCandidate {
                    path: "b.ts".into(),
                },
            ],
            vec![FileCandidate {
                path: "fuzzy.ts".into(),
            }],
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
            vec![FileCandidate {
                path: "literal.ts".into(),
            }],
            vec![FileCandidate {
                path: "fuzzy.ts".into(),
            }],
            5,
        );

        assert_eq!(results.len(), 1);
        match &results[0] {
            SearchHit::File { path, .. } => assert_eq!(path, "literal.ts"),
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
    fn detects_path_like_queries() {
        assert!(is_path_like_query("src/chat"));
        assert!(is_path_like_query("ChatWindow.tsx"));
        assert!(!is_path_like_query("TestClient"));
    }

    #[test]
    fn literal_file_candidates_prefer_filename_matches() {
        let files = vec![
            FileItem::new_raw(
                PathBuf::from("/tmp/src/deep/TestClientService.ts"),
                "src/deep/TestClientService.ts".into(),
                "TestClientService.ts".into(),
                100,
                0,
                None,
                false,
            ),
            FileItem::new_raw(
                PathBuf::from("/tmp/src/features/client/index.ts"),
                "src/features/client/index.ts".into(),
                "index.ts".into(),
                100,
                0,
                None,
                false,
            ),
        ];

        let candidates = collect_literal_file_candidates(&files, "testclient", false);
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].path, "/tmp/src/deep/TestClientService.ts");
    }

    #[test]
    fn case_sensitive_literal_file_candidates_require_exact_case() {
        let files = vec![FileItem::new_raw(
            PathBuf::from("/tmp/src/deep/TestClientService.ts"),
            "src/deep/TestClientService.ts".into(),
            "TestClientService.ts".into(),
            100,
            0,
            None,
            false,
        )];

        assert!(collect_literal_file_candidates(&files, "testclient", true).is_empty());
        assert_eq!(
            collect_literal_file_candidates(&files, "TestClient", true).len(),
            1
        );
    }

    #[test]
    fn literal_path_matches_stay_ahead_of_line_results_for_path_like_queries() {
        let results = order_results(
            "MessageV2.TextPart",
            true,
            vec![LineCandidate {
                path: "line.ts".into(),
                line_number: 8,
                column: 3,
                line_text: "MessageV2.TextPart".into(),
            }],
            vec![FileCandidate {
                path: "MessageV2.TextPart.ts".into(),
            }],
            vec![FileCandidate {
                path: "MessageV2TextPart.ts".into(),
            }],
            5,
        );

        assert_eq!(results.len(), 2);
        match &results[0] {
            SearchHit::File { path, .. } => assert_eq!(path, "MessageV2.TextPart.ts"),
            other => panic!("unexpected result: {other:?}"),
        }
        match &results[1] {
            SearchHit::File { path, .. } => assert_eq!(path, "MessageV2TextPart.ts"),
            other => panic!("unexpected result: {other:?}"),
        }
    }

    #[test]
    fn regex_file_candidates_prefer_filename_matches() {
        let files = vec![
            FileItem::new_raw(
                PathBuf::from("/tmp/src/deep/TestClientService.ts"),
                "src/deep/TestClientService.ts".into(),
                "TestClientService.ts".into(),
                100,
                0,
                None,
                false,
            ),
            FileItem::new_raw(
                PathBuf::from("/tmp/src/features/client/index.ts"),
                "src/features/client/index.ts".into(),
                "index.ts".into(),
                100,
                0,
                None,
                false,
            ),
        ];

        let regex = build_file_regex("TestClient.*", "TestClient.*", false, true)
            .expect("regex should compile")
            .expect("regex should be present");
        let candidates = collect_regex_file_candidates(&files, &regex);
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].path, "/tmp/src/deep/TestClientService.ts");
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
