use fff_core::grep::{GrepMode, GrepSearchOptions};
use fff_core::types::FileItem;

use crate::candidates::CandidateMetadata;

pub const MAX_GREP_FILE_SIZE_BYTES: u64 = 10 * 1024 * 1024;
pub const MAX_LINE_MATCHES_PER_FILE: usize = 100;
pub const GREP_TIME_BUDGET_MS: u64 = 0;
pub const DEFAULT_COMBO_BOOST_MULTIPLIER: i32 = 100;
pub const DEFAULT_MIN_COMBO_COUNT: u32 = 3;
pub const RAW_CANDIDATE_LIMIT_MULTIPLIER: usize = 8;
pub const MIN_RAW_CANDIDATE_LIMIT: usize = 600;
pub const MAX_RAW_CANDIDATE_LIMIT: usize = 1500;

pub fn raw_candidate_limit(limit: usize) -> usize {
    limit
        .saturating_mul(RAW_CANDIDATE_LIMIT_MULTIPLIER)
        .max(MIN_RAW_CANDIDATE_LIMIT)
        .min(MAX_RAW_CANDIDATE_LIMIT)
}

pub fn file_extension(file_name: &str) -> Option<String> {
    file_name
        .rsplit_once('.')
        .and_then(|(_, extension)| (!extension.is_empty()).then(|| extension.to_lowercase()))
}

pub fn is_searchable(file: &FileItem) -> bool {
    !file.is_binary && file.size <= MAX_GREP_FILE_SIZE_BYTES
}

pub fn should_use_fuzzy_file_fallback(
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

pub fn grep_options(limit: usize, case_sensitive: bool, regex_enabled: bool) -> GrepSearchOptions {
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

pub fn grep_mode(regex_enabled: bool) -> GrepMode {
    if regex_enabled {
        GrepMode::Regex
    } else {
        GrepMode::PlainText
    }
}

pub fn byte_column_to_utf16_column(line: &str, byte_column: usize) -> usize {
    let mut safe_boundary = byte_column.min(line.len());
    while safe_boundary > 0 && !line.is_char_boundary(safe_boundary) {
        safe_boundary -= 1;
    }

    line[..safe_boundary].encode_utf16().count() + 1
}

pub fn sort_file_items_by_path(files: &mut Vec<&FileItem>) {
    files.sort_by(|left, right| {
        left.relative_path
            .len()
            .cmp(&right.relative_path.len())
            .then(left.relative_path_lower.cmp(&right.relative_path_lower))
    });
}

pub fn adjusted_candidate_rank(metadata: &CandidateMetadata, policy: super::ranking::NoisyFilePolicy) -> i64 {
    metadata.raw_rank as i64 + policy.penalty(metadata)
}
