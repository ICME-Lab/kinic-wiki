// Where: crates/wiki_store/src/markdown.rs
// What: Deterministic markdown section splitting for wiki revisions.
// Why: Search projection and revision diffs operate on stable heading-based sections.
use std::collections::HashMap;

use pulldown_cmark::{Event, HeadingLevel, Options, Parser, Tag, TagEnd};

use crate::hashing::{normalize_text, sha256_hex};

#[derive(Clone, Debug)]
pub struct ParsedSection {
    pub section_path: String,
    pub ordinal: i64,
    pub heading: Option<String>,
    pub text: String,
    pub content_hash: String,
}

#[derive(Clone, Debug)]
struct HeadingBoundary {
    level: u8,
    title: String,
    start: usize,
}

pub fn split_markdown(markdown: &str) -> Result<Vec<ParsedSection>, String> {
    let boundaries = collect_headings(markdown)?;
    let mut sections = Vec::new();
    if boundaries.is_empty() {
        let text = markdown.trim().to_string();
        if text.is_empty() {
            return Ok(Vec::new());
        }
        sections.push(build_section("__intro__".to_string(), 0, None, text));
        return Ok(sections);
    }

    let intro = markdown[..boundaries[0].start].trim().to_string();
    let mut ordinal = 0_i64;
    if !intro.is_empty() {
        sections.push(build_section("__intro__".to_string(), ordinal, None, intro));
        ordinal += 1;
    }

    let paths = build_section_paths(&boundaries);
    for (index, boundary) in boundaries.iter().enumerate() {
        let end = next_section_end(markdown.len(), index, &boundaries);
        let text = markdown[boundary.start..end].trim().to_string();
        if text.is_empty() {
            continue;
        }
        sections.push(build_section(
            paths[index].clone(),
            ordinal,
            Some(boundary.title.clone()),
            text,
        ));
        ordinal += 1;
    }
    Ok(sections)
}

fn build_section(
    path: String,
    ordinal: i64,
    heading: Option<String>,
    text: String,
) -> ParsedSection {
    let hash_input = heading
        .as_deref()
        .map(|title| format!("{title}\n{text}"))
        .unwrap_or_else(|| text.clone());
    ParsedSection {
        section_path: path,
        ordinal,
        heading,
        text,
        content_hash: sha256_hex(&normalize_text(&hash_input)),
    }
}

fn collect_headings(markdown: &str) -> Result<Vec<HeadingBoundary>, String> {
    let parser = Parser::new_ext(markdown, Options::all()).into_offset_iter();
    let mut headings = Vec::new();
    let mut current: Option<(u8, usize, String)> = None;
    for (event, range) in parser {
        match event {
            Event::Start(Tag::Heading { level, .. }) => {
                current = Some((heading_level(level), range.start, String::new()));
            }
            Event::Text(text) | Event::Code(text) => {
                if let Some((_, _, title)) = &mut current {
                    title.push_str(&text);
                }
            }
            Event::End(TagEnd::Heading(..)) => {
                if let Some((level, start, title)) = current.take() {
                    let trimmed = title.trim().to_string();
                    if trimmed.is_empty() {
                        return Err("heading text must not be empty".to_string());
                    }
                    headings.push(HeadingBoundary {
                        level,
                        title: trimmed,
                        start,
                    });
                }
            }
            _ => {}
        }
    }
    Ok(headings)
}

fn build_section_paths(boundaries: &[HeadingBoundary]) -> Vec<String> {
    let mut stack: Vec<(u8, String)> = Vec::new();
    let mut sibling_counts = HashMap::<String, usize>::new();
    let mut paths = Vec::with_capacity(boundaries.len());
    for boundary in boundaries {
        while stack
            .last()
            .is_some_and(|(level, _)| *level >= boundary.level)
        {
            stack.pop();
        }
        let parent = stack
            .iter()
            .map(|(_, segment)| segment.as_str())
            .collect::<Vec<_>>()
            .join("/");
        let slug = slugify(&boundary.title);
        let key = format!("{parent}|{slug}");
        let count = sibling_counts
            .entry(key)
            .and_modify(|value| *value += 1)
            .or_insert(1);
        let segment = if *count == 1 {
            slug
        } else {
            format!("{slug}-{count}")
        };
        stack.push((boundary.level, segment.clone()));
        paths.push(
            stack
                .iter()
                .map(|(_, current)| current.as_str())
                .collect::<Vec<_>>()
                .join("/"),
        );
    }
    paths
}

fn next_section_end(markdown_len: usize, index: usize, boundaries: &[HeadingBoundary]) -> usize {
    let current_level = boundaries[index].level;
    boundaries
        .iter()
        .skip(index + 1)
        .find(|boundary| boundary.level <= current_level)
        .map(|boundary| boundary.start)
        .unwrap_or(markdown_len)
}

fn heading_level(level: HeadingLevel) -> u8 {
    match level {
        HeadingLevel::H1 => 1,
        HeadingLevel::H2 => 2,
        HeadingLevel::H3 => 3,
        HeadingLevel::H4 => 4,
        HeadingLevel::H5 => 5,
        HeadingLevel::H6 => 6,
    }
}

fn slugify(text: &str) -> String {
    let slug = text
        .chars()
        .flat_map(char::to_lowercase)
        .map(|ch| if ch.is_alphanumeric() { ch } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    if slug.is_empty() {
        "section".to_string()
    } else {
        slug
    }
}

#[cfg(test)]
mod tests {
    use super::split_markdown;

    #[test]
    fn headingless_markdown_becomes_intro_section() {
        let sections = split_markdown("lead paragraph\n\nmore").expect("markdown should parse");
        assert_eq!(sections.len(), 1);
        assert_eq!(sections[0].section_path, "__intro__");
    }

    #[test]
    fn duplicate_sibling_headings_get_suffixes() {
        let sections = split_markdown("# Root\n\n## Child\n\none\n\n## Child\n\ntwo")
            .expect("markdown should parse");
        let paths = sections
            .iter()
            .map(|section| section.section_path.as_str())
            .collect::<Vec<_>>();
        assert!(paths.contains(&"root/child"));
        assert!(paths.contains(&"root/child-2"));
    }
}
