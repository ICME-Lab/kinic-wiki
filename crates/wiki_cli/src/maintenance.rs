// Where: crates/wiki_cli/src/maintenance.rs
// What: Deterministic wiki maintenance helper for index rebuild.
// Why: VFS-first CLI keeps system-file updates explicit without reintroducing workflow commands.
use anyhow::{Result, anyhow, bail};
use std::collections::BTreeSet;
use wiki_types::{ListNodesRequest, Node, NodeEntry, NodeEntryKind, NodeKind, WriteNodeRequest};

use crate::client::WikiApi;

const WIKI_PREFIX: &str = "/Wiki";
const INDEX_PATH: &str = "/Wiki/index.md";
const ROOT_SCOPE_SECTION: &str = "Scopes";
const RESERVED_ROOT_SCOPES: [&str; 3] = ["sources", "entities", "concepts"];
const KNOWN_SCOPE_NOTES: [&str; 7] = [
    "facts.md",
    "events.md",
    "plans.md",
    "preferences.md",
    "open_questions.md",
    "summary.md",
    "provenance.md",
];

pub async fn rebuild_index(client: &impl WikiApi) -> Result<()> {
    let entries = client
        .list_nodes(ListNodesRequest {
            prefix: WIKI_PREFIX.to_string(),
            recursive: true,
        })
        .await?;
    let mut scopes = Vec::new();
    let mut sources = Vec::new();
    let mut entities = Vec::new();
    let mut concepts = Vec::new();
    for entry in entries {
        if entry.kind != NodeEntryKind::File || entry.path == INDEX_PATH {
            continue;
        }
        let node = match client.read_node(&entry.path).await? {
            Some(node) => node,
            None => continue,
        };
        if let Some(scope_item) = render_root_scope_item(&node) {
            scopes.push(scope_item);
            continue;
        }
        let rendered = render_index_item(&node);
        if entry.path.starts_with("/Wiki/sources/") {
            sources.push(rendered);
        } else if entry.path.starts_with("/Wiki/entities/") {
            entities.push(rendered);
        } else if entry.path.starts_with("/Wiki/concepts/") {
            concepts.push(rendered);
        }
    }
    scopes.sort();
    let body = render_index(&scopes, &sources, &entities, &concepts);
    upsert_node(client, INDEX_PATH, NodeKind::File, &body).await
}

pub async fn rebuild_scope_index(client: &impl WikiApi, scope: &str) -> Result<()> {
    let scope_name = normalize_scope_name(scope)?;
    let ancestors = scope_ancestors(&scope_name);
    let mut ensured_index_paths = Vec::new();
    for current_scope in &ancestors {
        let scope_prefix = format!("{WIKI_PREFIX}/{current_scope}");
        let scope_index_path = format!("{scope_prefix}/index.md");
        let entries = client
            .list_nodes(ListNodesRequest {
                prefix: scope_prefix.clone(),
                recursive: true,
            })
            .await?;
        let entries = with_ensured_index_entries(entries, &ensured_index_paths, &scope_prefix);
        let scope_index = render_scope_index(current_scope, &scope_prefix, &entries)?;
        upsert_node(client, &scope_index_path, NodeKind::File, &scope_index).await?;
        ensured_index_paths.push(scope_index_path);
    }

    if let Some(root_scope) = ancestors
        .last()
        .filter(|scope| !scope.contains('/') && !RESERVED_ROOT_SCOPES.contains(&scope.as_str()))
    {
        let scope_prefix = format!("{WIKI_PREFIX}/{root_scope}");
        let scope_index_path = format!("{scope_prefix}/index.md");
        let scope_index = client
            .read_node(&scope_index_path)
            .await?
            .map(|node| node.content)
            .unwrap_or_else(|| String::from("# Index\n"));
        let summary = first_summary_line(&scope_index);
        let current_root = client
            .read_node(INDEX_PATH)
            .await?
            .map(|node| node.content)
            .unwrap_or_else(|| String::from("# Index\n"));
        let entry = format!("- [{root_scope}]({scope_index_path}) - {summary}");
        let root_index =
            upsert_list_entry(&current_root, ROOT_SCOPE_SECTION, &entry, &scope_index_path);
        upsert_node(client, INDEX_PATH, NodeKind::File, &root_index).await?;
    }

    Ok(())
}

async fn upsert_node(
    client: &impl WikiApi,
    path: &str,
    kind: NodeKind,
    content: &str,
) -> Result<()> {
    let current = client.read_node(path).await?;
    client
        .write_node(WriteNodeRequest {
            path: path.to_string(),
            kind,
            content: content.to_string(),
            metadata_json: "{}".to_string(),
            expected_etag: current.map(|node| node.etag),
        })
        .await?;
    Ok(())
}

fn render_index(
    scopes: &[String],
    sources: &[String],
    entities: &[String],
    concepts: &[String],
) -> String {
    let mut out = String::from("# Index\n\n");
    push_index_section(&mut out, ROOT_SCOPE_SECTION, scopes);
    push_index_section(&mut out, "Sources", sources);
    push_index_section(&mut out, "Entities", entities);
    push_index_section(&mut out, "Concepts", concepts);
    out
}

fn push_index_section(out: &mut String, title: &str, items: &[String]) {
    out.push_str(&format!("## {title}\n\n"));
    if items.is_empty() {
        out.push_str("- none\n\n");
        return;
    }
    for item in items {
        out.push_str(item);
        out.push('\n');
    }
    out.push('\n');
}

fn render_index_item(node: &Node) -> String {
    let label =
        title_from_content(&node.content).unwrap_or_else(|| fallback_label_from_path(&node.path));
    format!(
        "- [{}]({}) — {}",
        label,
        node.path,
        first_summary_line(&node.content)
    )
}

fn render_root_scope_item(node: &Node) -> Option<String> {
    let relative = node.path.strip_prefix(&format!("{WIKI_PREFIX}/"))?;
    let (scope_name, remainder) = relative.split_once('/')?;
    if remainder != "index.md"
        || scope_name.is_empty()
        || RESERVED_ROOT_SCOPES.contains(&scope_name)
    {
        return None;
    }
    Some(format!(
        "- [{scope_name}]({}) - {}",
        node.path,
        first_summary_line(&node.content)
    ))
}

fn render_scope_index(
    scope_name: &str,
    scope_prefix: &str,
    entries: &[NodeEntry],
) -> Result<String> {
    let mut child_scope_names = BTreeSet::new();
    let mut note_paths = Vec::new();
    let index_path = format!("{scope_prefix}/index.md");
    for entry in entries {
        if entry.kind == NodeEntryKind::Directory || entry.path == index_path {
            continue;
        }
        let Some(relative_path) = entry.path.strip_prefix(&format!("{scope_prefix}/")) else {
            continue;
        };
        match relative_path.split_once('/') {
            Some((child_scope, "index.md")) => {
                child_scope_names.insert(child_scope.to_string());
            }
            None => note_paths.push(entry.path.clone()),
            Some(_) => {}
        }
    }
    note_paths.sort_by(|left, right| compare_scope_note_paths(left, right));

    let mut out = String::from("# Index\n\n");
    out.push_str(&format!("Scope entry point for {scope_name}.\n\n"));
    push_scope_rows(
        &mut out,
        "Scopes",
        child_scope_names.iter().map(|child_scope| {
            let path = format!("{scope_prefix}/{child_scope}/index.md");
            format!("- [{child_scope}]({path})")
        }),
    );
    push_scope_rows(
        &mut out,
        "Notes",
        note_paths.iter().map(|path| {
            let label = fallback_label_from_path(path);
            format!("- [{label}]({path})")
        }),
    );
    if out.is_empty() {
        return Err(anyhow!("scope index render failed"));
    }
    Ok(out)
}

fn push_scope_rows<I>(out: &mut String, title: &str, rows: I)
where
    I: IntoIterator<Item = String>,
{
    out.push_str(&format!("## {title}\n\n"));
    let mut wrote_row = false;
    for row in rows {
        wrote_row = true;
        out.push_str(&row);
        out.push('\n');
    }
    if !wrote_row {
        out.push_str("- none\n");
    }
    out.push('\n');
}

fn normalize_scope_name(scope: &str) -> Result<String> {
    let trimmed = scope.trim().trim_matches('/');
    if trimmed.is_empty() {
        bail!("scope must not be empty");
    }
    let without_prefix = trimmed
        .strip_prefix("Wiki/")
        .or_else(|| trimmed.strip_prefix("Wiki"))
        .unwrap_or(trimmed);
    let normalized = without_prefix.trim_matches('/');
    if normalized.is_empty() {
        bail!("scope must not be empty");
    }
    for segment in normalized.split('/') {
        if segment.is_empty() || matches!(segment, "." | ".." | "index.md") {
            bail!("scope must be a valid /Wiki/<scope> path");
        }
    }
    Ok(normalized.to_string())
}

fn scope_ancestors(scope: &str) -> Vec<String> {
    let mut scopes = Vec::new();
    let mut parts = scope.split('/').collect::<Vec<_>>();
    while !parts.is_empty() {
        scopes.push(parts.join("/"));
        parts.pop();
    }
    scopes
}

fn with_ensured_index_entries(
    mut entries: Vec<NodeEntry>,
    ensured_index_paths: &[String],
    scope_prefix: &str,
) -> Vec<NodeEntry> {
    for path in ensured_index_paths {
        if !path.starts_with(&format!("{scope_prefix}/"))
            || entries.iter().any(|entry| entry.path == *path)
        {
            continue;
        }
        entries.push(NodeEntry {
            path: path.clone(),
            kind: NodeEntryKind::File,
            updated_at: 0,
            etag: String::new(),
            has_children: false,
        });
    }
    entries
}

fn compare_scope_note_paths(left: &str, right: &str) -> std::cmp::Ordering {
    let left_name = left.rsplit('/').next().unwrap_or(left);
    let right_name = right.rsplit('/').next().unwrap_or(right);
    known_note_rank(left_name)
        .cmp(&known_note_rank(right_name))
        .then_with(|| left_name.cmp(right_name))
}

fn known_note_rank(name: &str) -> usize {
    KNOWN_SCOPE_NOTES
        .iter()
        .position(|known| known == &name)
        .unwrap_or(KNOWN_SCOPE_NOTES.len())
}

fn upsert_list_entry(content: &str, title: &str, entry: &str, entry_link: &str) -> String {
    let heading = format!("## {title}\n\n");
    if let Some(start) = content.find(&heading) {
        let section_start = start + heading.len();
        let rest = &content[section_start..];
        let section_end = rest
            .find("\n## ")
            .map(|offset| section_start + offset)
            .unwrap_or(content.len());
        let mut lines = content[section_start..section_end]
            .lines()
            .filter(|line| !line.contains(entry_link))
            .filter(|line| !line.trim().is_empty())
            .map(ToOwned::to_owned)
            .collect::<Vec<_>>();
        lines.retain(|line| line.trim() != "- none");
        lines.push(entry.to_string());
        lines.sort();

        let body = if lines.is_empty() {
            String::from("- none")
        } else {
            lines.join("\n")
        };
        return replace_section(content, title, &body);
    }

    let body = format!("{entry}\n");
    let trimmed = content.trim_end();
    if trimmed.is_empty() {
        return format!("# Index\n\n## {title}\n\n{body}");
    }
    format!("{trimmed}\n\n## {title}\n\n{body}")
}

fn replace_section(content: &str, title: &str, body: &str) -> String {
    let heading = format!("## {title}\n\n");
    let start = content.find(&heading).unwrap_or(content.len());
    let section_start = start + heading.len();
    let rest = &content[section_start..];
    let section_end = rest
        .find("\n## ")
        .map(|offset| section_start + offset)
        .unwrap_or(content.len());
    let mut out = String::new();
    out.push_str(&content[..section_start]);
    out.push_str(body.trim_end());
    out.push_str("\n\n");
    out.push_str(content[section_end..].trim_start_matches('\n'));
    if !out.ends_with('\n') {
        out.push('\n');
    }
    out
}

fn title_from_content(content: &str) -> Option<String> {
    content
        .lines()
        .find_map(|line| line.strip_prefix("# ").map(str::to_string))
}

fn fallback_label_from_path(path: &str) -> String {
    path.trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or(path)
        .trim_end_matches(".md")
        .to_string()
}

fn first_summary_line(content: &str) -> String {
    content
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with('#') && *line != "---")
        .unwrap_or("No summary available.")
        .to_string()
}
