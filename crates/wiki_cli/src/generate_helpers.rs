// Where: crates/wiki_cli/src/generate_helpers.rs
// What: Helper functions for page-map inference and draft text shaping.
// Why: Keep generate.rs focused on flow orchestration instead of string heuristics.
use wiki_types::WikiPageType;

pub fn infer_page_type(stem: &str, title: &str, markdown: &str) -> WikiPageType {
    let signals = collect_type_signals(stem, title, markdown);
    if contains_any(&signals, &["compare", "comparison", "vs", "tradeoff"]) {
        WikiPageType::Comparison
    } else if contains_any(
        &signals,
        &["query", "question", "open question", "investigation"],
    ) {
        WikiPageType::QueryNote
    } else if contains_any(&signals, &["source", "article", "paper", "summary"]) {
        WikiPageType::SourceSummary
    } else if contains_any(
        &signals,
        &[
            "concept",
            "mechanism",
            "pattern",
            "model",
            "workflow",
            "system",
        ],
    ) {
        WikiPageType::Concept
    } else {
        WikiPageType::Entity
    }
}

pub fn first_heading(markdown: &str) -> Option<String> {
    markdown.lines().find_map(|line| {
        line.strip_prefix("# ")
            .map(|value| value.trim().to_string())
    })
}

pub fn split_first_heading(markdown: &str) -> Option<(&str, &str)> {
    let rest = markdown.strip_prefix("# ")?;
    let end = rest.find('\n')?;
    let heading = &markdown[..end + 2];
    let remaining = &markdown[end + 2..];
    Some((heading, remaining))
}

pub fn slugify(input: &str) -> String {
    let mut slug = String::new();
    let mut last_was_dash = false;
    for character in input.chars() {
        let normalized = character.to_ascii_lowercase();
        if normalized.is_ascii_alphanumeric() {
            slug.push(normalized);
            last_was_dash = false;
            continue;
        }
        if !last_was_dash && !slug.is_empty() {
            slug.push('-');
            last_was_dash = true;
        }
    }
    slug.trim_matches('-').to_string()
}

pub fn titleize_slug(input: &str) -> String {
    input
        .split('-')
        .filter(|segment| !segment.is_empty())
        .map(|segment| {
            let mut characters = segment.chars();
            match characters.next() {
                Some(first) => format!("{}{}", first.to_ascii_uppercase(), characters.as_str()),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn describe_page(title: &str, page_type: &WikiPageType) -> String {
    format!("{} [{}]", title, page_type.as_str())
}

fn collect_type_signals(stem: &str, title: &str, markdown: &str) -> String {
    let mut signals = vec![stem.to_ascii_lowercase(), title.to_ascii_lowercase()];
    for line in markdown.lines().take(12) {
        if line.starts_with('#') || signals.len() < 5 {
            signals.push(line.trim().to_ascii_lowercase());
        }
    }
    signals.join(" ")
}

fn contains_any(haystack: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| haystack.contains(needle))
}
