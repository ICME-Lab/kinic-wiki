// Where: crates/wiki_cli/src/mirror_normalize.rs
// What: Markdown normalization for the local wiki mirror.
// Why: The mirror should preserve Obsidian-friendly wikilinks for graph and backlink features.
use std::collections::HashSet;

pub fn normalize_system_markdown(markdown: &str, known_slugs: &HashSet<String>) -> String {
    let mut linked_lists = markdown
        .lines()
        .map(|line| {
            match line
                .strip_prefix("- ")
                .and_then(|rest| rest.split_once(" — "))
            {
                Some((slug, summary)) if known_slugs.contains(slug) => {
                    format!("- [[{slug}]] — {summary}")
                }
                _ => line.to_string(),
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    if markdown.ends_with('\n') {
        linked_lists.push('\n');
    }
    normalize_page_markdown(&linked_lists, known_slugs)
}

pub fn normalize_page_markdown(markdown: &str, known_slugs: &HashSet<String>) -> String {
    let wiki = replace_wikilinks(markdown, known_slugs);
    replace_markdown_links(&wiki, known_slugs)
}

fn replace_wikilinks(markdown: &str, known_slugs: &HashSet<String>) -> String {
    markdown
        .split("[[")
        .enumerate()
        .map(|(index, part)| {
            if index == 0 {
                return part.to_string();
            }
            if let Some((target, rest)) = part.split_once("]]") {
                let canonical = canonical_slug(target);
                if known_slugs.contains(&canonical) {
                    format!("[[{canonical}]]{rest}")
                } else {
                    format!("[[{target}]]{rest}")
                }
            } else {
                format!("[[{part}")
            }
        })
        .collect::<String>()
}

fn replace_markdown_links(markdown: &str, known_slugs: &HashSet<String>) -> String {
    let mut output = String::new();
    let mut index = 0usize;
    while index < markdown.len() {
        let rest = &markdown[index..];
        if let Some(end) = rest.strip_prefix("[[").and_then(|tail| tail.find("]]")) {
            let whole_end = end + 4;
            output.push_str(&rest[..whole_end]);
            index += whole_end;
            continue;
        }
        if !rest.starts_with('[') {
            let next = rest.chars().next().unwrap_or_default();
            output.push(next);
            index += next.len_utf8();
            continue;
        }

        let Some(bracket_end) = rest.find(']') else {
            output.push('[');
            index += 1;
            continue;
        };
        if !rest[bracket_end..].starts_with("](") {
            output.push('[');
            index += 1;
            continue;
        }
        let label_end = bracket_end;
        let url_start = label_end + 2;
        let Some(url_end) = rest[url_start..].find(')') else {
            output.push('[');
            index += 1;
            continue;
        };
        let whole_end = url_start + url_end;
        let url = &rest[url_start..whole_end];
        let canonical = canonical_slug(url);
        if known_slugs.contains(&canonical) {
            output.push_str(&format!("[[{canonical}]]"));
        } else {
            output.push_str(&rest[..=whole_end]);
        }
        index += whole_end + 1;
    }
    output
}

fn canonical_slug(input: &str) -> String {
    input
        .trim()
        .trim_start_matches("./")
        .trim_start_matches('/')
        .trim_start_matches("Wiki/pages/")
        .trim_start_matches("pages/")
        .split('|')
        .next()
        .unwrap_or_default()
        .trim_end_matches(".md")
        .to_string()
}
