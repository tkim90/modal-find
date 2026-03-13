use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Request {
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
pub enum Response {
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
pub enum SearchHit {
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
