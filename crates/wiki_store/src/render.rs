// Where: crates/wiki_store/src/render.rs
// What: Renderers for materialized system pages like index.md and log.md.
// Why: The wiki keeps navigation and chronology in stored markdown views, not hand-maintained files.
use std::collections::BTreeMap;

use time::{OffsetDateTime, format_description::BorrowedFormatItem};
use wiki_types::{SystemPage, WikiPage, WikiPageType};

use crate::hashing::sha256_hex;

const DATE_FORMAT: &[BorrowedFormatItem<'static>] =
    time::macros::format_description!("[year]-[month]-[day]");

pub fn render_index_page(pages: &[WikiPage], updated_at: i64) -> SystemPage {
    let mut groups = BTreeMap::<&str, Vec<&WikiPage>>::new();
    for page in pages {
        groups
            .entry(page.page_type.group_label())
            .or_default()
            .push(page);
    }
    let mut markdown = String::from("# Index\n");
    for (label, pages) in groups {
        markdown.push_str(&format!("\n## {label}\n"));
        for page in pages {
            let summary = page.summary_1line.as_deref().unwrap_or(&page.title);
            markdown.push_str(&format!("- {} — {}\n", page.slug, summary));
        }
    }
    build_system_page("index.md", markdown, updated_at)
}

pub fn render_log_page(entries: &[(i64, String, String, String)], updated_at: i64) -> SystemPage {
    let mut markdown = String::from("# Log\n");
    for (created_at, event_type, title, body) in entries {
        let stamp = OffsetDateTime::from_unix_timestamp(*created_at)
            .ok()
            .and_then(|time| time.format(DATE_FORMAT).ok())
            .unwrap_or_else(|| "1970-01-01".to_string());
        markdown.push_str(&format!(
            "\n## [{stamp}] {event_type} | {title}\n\n{body}\n"
        ));
    }
    build_system_page("log.md", markdown, updated_at)
}

pub fn build_system_page(slug: &str, markdown: String, updated_at: i64) -> SystemPage {
    SystemPage {
        slug: slug.to_string(),
        etag: sha256_hex(&markdown),
        markdown,
        updated_at,
    }
}

pub fn summary_from_title(title: &str, page_type: &WikiPageType) -> String {
    format!("{} {}", page_type.group_label(), title)
        .trim()
        .to_string()
}
