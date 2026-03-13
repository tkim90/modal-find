use std::collections::{HashMap, HashSet};
use fff_core::constraints::path_contains_segment;

use crate::candidates::{
    CandidateMetadata, FileCandidate, LineCandidate, MergedCandidate,
};
use crate::helpers::adjusted_candidate_rank;
use crate::protocol::SearchHit;

pub const FIRST_PASS_MAX_RESULTS_PER_FILE: usize = 2;
pub const FIRST_PASS_MAX_RESULTS_PER_BUCKET: usize = 24;
pub const LARGE_FILE_SIZE_BYTES: u64 = 256 * 1024;
pub const VERY_LARGE_FILE_SIZE_BYTES: u64 = 1024 * 1024;
pub const HEAVY_NOISE_PENALTY: i64 = 5_000;
pub const MEDIUM_NOISE_PENALTY: i64 = 1_000;
pub const LARGE_FILE_PENALTY: i64 = 200;
pub const VERY_LARGE_FILE_PENALTY: i64 = 500;

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

#[derive(Debug, Default, Clone, Copy)]
pub struct NoisyFilePolicy;

impl NoisyFilePolicy {
    pub fn penalty(self, metadata: &CandidateMetadata) -> i64 {
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

pub fn order_results(
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
