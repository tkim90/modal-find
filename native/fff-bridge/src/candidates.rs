use fff_core::types::FileItem;
use regex::bytes::Regex as BytesRegex;

use crate::helpers::{file_extension, sort_file_items_by_path};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CandidateKind {
    File,
    Line,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum CandidateSource {
    ExactFile,
    FuzzyFile,
    GrepLine,
}

#[derive(Debug, Clone)]
pub struct CandidateMetadata {
    pub relative_path: String,
    pub relative_path_lower: String,
    pub basename_lower: String,
    pub extension: Option<String>,
    pub size: u64,
    pub raw_rank: usize,
    pub source: CandidateSource,
}

#[derive(Debug, Clone)]
pub struct FileCandidate {
    pub path: String,
    pub metadata: CandidateMetadata,
}

#[derive(Debug, Clone)]
pub struct LineCandidate {
    pub path: String,
    pub line_number: u64,
    pub column: usize,
    pub line_text: String,
    pub metadata: CandidateMetadata,
}

#[derive(Debug, Clone)]
pub enum MergedCandidate {
    File(FileCandidate),
    Line(LineCandidate),
}

pub fn build_candidate_metadata(
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

pub fn build_file_candidate_metadata(
    file: &FileItem,
    raw_rank: usize,
    source: CandidateSource,
) -> CandidateMetadata {
    let mut metadata = build_candidate_metadata(file, raw_rank, CandidateKind::File);
    metadata.source = source;
    metadata
}

pub fn collect_literal_file_candidates(
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

pub fn collect_scoped_file_candidates(files: &[FileItem], base_raw_rank: usize) -> Vec<FileCandidate> {
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

pub fn collect_regex_file_candidates(
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
