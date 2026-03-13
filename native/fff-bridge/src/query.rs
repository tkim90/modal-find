use anyhow::{Result, anyhow};
use fff_core::grep::parse_grep_query;
use fff_core::types::FileItem;
use fff_core::{Constraint, FFFQuery};
use regex::bytes::{Regex as BytesRegex, RegexBuilder as BytesRegexBuilder};
use std::borrow::Cow;
use fff_core::constraints::apply_constraints;

#[derive(Debug)]
pub struct SearchQueryPlan<'a> {
    pub original_query: &'a str,
    pub parsed_grep_query: Option<FFFQuery<'a>>,
    pub match_text: String,
    pub normalized_match_text: String,
    pub path_like_query: bool,
    pub file_regex: Option<BytesRegex>,
}

impl<'a> SearchQueryPlan<'a> {
    pub fn build(query: &'a str, case_sensitive: bool, regex_enabled: bool) -> Result<Self> {
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

    pub fn constraints(&self) -> &[Constraint<'a>] {
        self.parsed_grep_query
            .as_ref()
            .map(|query| query.constraints.as_slice())
            .unwrap_or(&[])
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

pub fn is_path_like_query(query: &str) -> bool {
    query.contains('/')
        || query.contains('\\')
        || query.contains('.')
        || query.contains('_')
        || query.contains('-')
}

pub fn build_file_regex(
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

pub fn scope_files<'a>(files: &'a [FileItem], constraints: &[Constraint<'_>]) -> Cow<'a, [FileItem]> {
    if constraints.is_empty() {
        return Cow::Borrowed(files);
    }

    match apply_constraints(files, constraints) {
        Some(filtered) => Cow::Owned(filtered.into_iter().cloned().collect()),
        None => Cow::Borrowed(files),
    }
}
