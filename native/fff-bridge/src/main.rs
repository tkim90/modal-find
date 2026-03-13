mod app;
mod candidates;
mod helpers;
mod protocol;
mod query;
mod ranking;

use anyhow::Result;
use std::io::{self, BufRead, Write};

use app::App;
use protocol::{Request, Response};

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

#[cfg(test)]
mod tests {
    use crate::candidates::{
        CandidateKind, CandidateSource, FileCandidate, LineCandidate,
        build_candidate_metadata, build_file_candidate_metadata,
        collect_literal_file_candidates, collect_regex_file_candidates,
        collect_scoped_file_candidates,
    };
    use crate::helpers::should_use_fuzzy_file_fallback;
    use crate::protocol::{Request, Response, SearchHit};
    use crate::query::{SearchQueryPlan, build_file_regex, is_path_like_query, scope_files};
    use crate::ranking::{NoisyFilePolicy, order_results};

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
        assert!(matches!(results[0], SearchHit::Line { .. }));
        assert!(matches!(results[1], SearchHit::File { .. }));
        assert!(matches!(results[2], SearchHit::File { .. }));
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
