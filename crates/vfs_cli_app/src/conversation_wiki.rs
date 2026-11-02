// Where: crates/vfs_cli_app/src/conversation_wiki.rs
// What: Generate a minimal conversation knowledge scope from a persisted raw source node.
// Why: Chrome capture should only persist evidence; knowledge pages are created on demand.
use anyhow::{Result, anyhow};
use chrono::Utc;
use serde::Serialize;
use vfs_client::VfsApi;
use vfs_types::{Node, NodeKind, WriteNodeItem, WriteNodesRequest};
use wiki_domain::{KNOWLEDGE_SOURCES_PREFIX, validate_knowledge_source_path};

const CONVERSATION_WIKI_PREFIX: &str = "/Knowledge/conversations";

#[derive(Debug, Clone, PartialEq, Eq)]
struct RawConversation {
    source_path: String,
    source_id: String,
    provider: String,
    source_url: String,
    captured_at: String,
    title: String,
    message_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct WikiDocument {
    path: String,
    content: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConversationWikiResult {
    pub source_path: String,
    pub base_path: String,
    pub written_paths: Vec<String>,
}

pub async fn generate_conversation_wiki(
    client: &impl VfsApi,
    database_id: &str,
    source_path: &str,
) -> Result<ConversationWikiResult> {
    let source = client
        .read_node(database_id, source_path)
        .await?
        .ok_or_else(|| anyhow!("source node not found: {source_path}"))?;
    if source.kind != NodeKind::Source {
        return Err(anyhow!("node is not a source: {source_path}"));
    }
    let raw = parse_raw_conversation(&source.path, &source.content)?;
    let base_path = format!("{CONVERSATION_WIKI_PREFIX}/{}", raw.source_id);
    let mut documents = build_wiki_documents(&raw, &base_path);
    let log_path = format!("{base_path}/log.md");
    let mut written_paths = documents.iter().map(|d| d.path.clone()).collect::<Vec<_>>();
    written_paths.push(log_path.clone());
    let current = vfs_client::read_nodes_chunked(client, database_id, &written_paths).await?;
    let log_current = current.last().and_then(Option::as_ref);
    documents.push(log_document(log_current, log_path, &raw));
    let nodes = documents
        .into_iter()
        .zip(current)
        .map(|(document, existing)| WriteNodeItem {
            path: document.path,
            kind: NodeKind::File,
            content: document.content,
            metadata_json: "{}".into(),
            expected_etag: existing.map(|n| n.etag),
        })
        .collect();
    client
        .write_nodes(WriteNodesRequest {
            database_id: database_id.into(),
            nodes,
        })
        .await?;

    Ok(ConversationWikiResult {
        source_path: raw.source_path,
        base_path,
        written_paths,
    })
}

fn parse_raw_conversation(source_path: &str, content: &str) -> Result<RawConversation> {
    let source_id = source_id_from_path(source_path)?;
    let provider = metadata_value(content, "provider").unwrap_or_else(|| "unknown".to_string());
    let source_url = metadata_value(content, "source_url").unwrap_or_default();
    let captured_at = metadata_value(content, "captured_at").unwrap_or_default();
    let title = metadata_value(content, "conversation_title").unwrap_or_else(|| source_id.clone());
    let message_count = metadata_value(content, "message_count")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or_else(|| count_turns(content));
    Ok(RawConversation {
        source_path: source_path.to_string(),
        source_id,
        provider,
        source_url,
        captured_at,
        title,
        message_count,
    })
}

fn source_id_from_path(source_path: &str) -> Result<String> {
    validate_knowledge_source_path(source_path).map_err(anyhow::Error::msg)?;
    let relative = source_path
        .strip_prefix(&format!("{KNOWLEDGE_SOURCES_PREFIX}/"))
        .ok_or_else(|| {
            anyhow!("source path must be under {KNOWLEDGE_SOURCES_PREFIX}: {source_path}")
        })?;
    let mut segments = relative
        .split('/')
        .filter(|segment| !segment.is_empty())
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    let Some(last) = segments.last_mut() else {
        return Err(anyhow!("source path is missing source file: {source_path}"));
    };
    if let Some(file_stem) = last.strip_suffix(".md") {
        *last = file_stem.to_string();
    }
    Ok(segments.join("-"))
}

fn metadata_value(content: &str, key: &str) -> Option<String> {
    content.lines().find_map(|line| {
        let trimmed = line.trim();
        let value = trimmed.strip_prefix(&format!("- {key}:"))?.trim();
        Some(clean_metadata_value(value)).filter(|value| !value.is_empty())
    })
}

fn clean_metadata_value(value: &str) -> String {
    if value.starts_with('"') && value.ends_with('"') {
        return serde_json::from_str::<String>(value).unwrap_or_else(|_| value.to_string());
    }
    value.to_string()
}

fn count_turns(content: &str) -> usize {
    content
        .lines()
        .filter(|line| line.trim_start().starts_with("### Turn "))
        .count()
}

fn build_wiki_documents(raw: &RawConversation, base_path: &str) -> Vec<WikiDocument> {
    vec![
        WikiDocument {
            path: format!("{base_path}/index.md"),
            content: index_markdown(raw, base_path),
        },
        WikiDocument {
            path: format!("{base_path}/summary.md"),
            content: summary_markdown(raw, base_path),
        },
        WikiDocument {
            path: format!("{base_path}/facts.md"),
            content: empty_note("Facts", base_path, &["index.md", "provenance.md"]),
        },
        WikiDocument {
            path: format!("{base_path}/events.md"),
            content: empty_note("Events", base_path, &["index.md", "provenance.md"]),
        },
        WikiDocument {
            path: format!("{base_path}/plans.md"),
            content: empty_note("Plans", base_path, &["index.md", "provenance.md"]),
        },
        WikiDocument {
            path: format!("{base_path}/preferences.md"),
            content: empty_note("Preferences", base_path, &["index.md", "provenance.md"]),
        },
        WikiDocument {
            path: format!("{base_path}/open_questions.md"),
            content: empty_note("Open Questions", base_path, &["index.md", "provenance.md"]),
        },
        WikiDocument {
            path: format!("{base_path}/provenance.md"),
            content: provenance_markdown(raw, base_path),
        },
    ]
}

fn index_markdown(raw: &RawConversation, base_path: &str) -> String {
    format!(
        "# Conversation Index\n\n## Source\n\n- title: {}\n- provider: {}\n- captured_at: {}\n- source: [{}]({})\n\n## Pages\n\n- [summary.md]({base_path}/summary.md)\n- [facts.md]({base_path}/facts.md)\n- [events.md]({base_path}/events.md)\n- [plans.md]({base_path}/plans.md)\n- [preferences.md]({base_path}/preferences.md)\n- [open_questions.md]({base_path}/open_questions.md)\n- [provenance.md]({base_path}/provenance.md)\n",
        raw.title, raw.provider, raw.captured_at, raw.source_path, raw.source_path
    )
}

fn summary_markdown(raw: &RawConversation, base_path: &str) -> String {
    format!(
        "# Summary\n\n## Related\n\n- [index.md]({base_path}/index.md)\n- [provenance.md]({base_path}/provenance.md)\n\n## Overview\n\nCaptured {} messages from {}. This page is a review scaffold; use the raw source only as evidence.\n",
        raw.message_count, raw.provider
    )
}

fn empty_note(title: &str, base_path: &str, related: &[&str]) -> String {
    let mut out = format!("# {title}\n\n## Related\n\n");
    for file in related {
        out.push_str(&format!("- [{file}]({base_path}/{file})\n"));
    }
    out.push_str("\n## Entries\n\n- none\n");
    out
}

fn provenance_markdown(raw: &RawConversation, base_path: &str) -> String {
    format!(
        "# Provenance\n\n## Related\n\n- [index.md]({base_path}/index.md)\n\n## Raw Source\n\n- source_path: {}\n- provider: {}\n- source_url: {}\n- captured_at: {}\n- message_count: {}\n",
        raw.source_path, raw.provider, raw.source_url, raw.captured_at, raw.message_count
    )
}

fn log_document(existing: Option<&Node>, path: String, raw: &RawConversation) -> WikiDocument {
    let current = existing
        .map(|node| node.content.clone())
        .unwrap_or_else(|| "# Log\n\n".to_string());
    let entry = format!(
        "- {} generated conversation wiki from {}\n",
        Utc::now().to_rfc3339(),
        raw.source_path
    );
    WikiDocument {
        path,
        content: format!("{}\n{entry}", current.trim_end()),
    }
}

#[cfg(test)]
mod tests {
    use super::{build_wiki_documents, parse_raw_conversation};

    const RAW: &str = "# Raw Conversation Source\n\n## Metadata\n\n- provider: chatgpt\n- source_url: https://chatgpt.com/c/abc\n- captured_at: 2026-05-01T00:00:00.000Z\n- conversation_title: Project Notes\n- message_count: 2\n\n## Chat\n\n### Turn 0001\n\n- role: user\n\nsecret fact\n\n### Turn 0002\n\n- role: assistant\n\nanswer\n";

    #[tokio::test]
    async fn generation_batches_documents_and_guards_log_content() {
        use crate::commands_fs_tests::MockClient;
        use std::sync::atomic::Ordering;
        use vfs_types::{Node, NodeKind};
        let make = |path: &str, kind, content: &str| Node {
            path: path.into(),
            kind,
            content: content.into(),
            created_at: 0,
            updated_at: 0,
            etag: "old-etag".into(),
            metadata_json: "{}".into(),
        };
        let client = MockClient {
            nodes: vec![
                make("/Sources/chatgpt/abc.md", NodeKind::Source, RAW),
                make(
                    "/Knowledge/conversations/chatgpt-abc/log.md",
                    NodeKind::File,
                    "# Log\n\nold entry\n",
                ),
            ],
            ..Default::default()
        };
        super::generate_conversation_wiki(&client, "db", "/Sources/chatgpt/abc.md")
            .await
            .unwrap();
        assert_eq!(client.batch_reads.load(Ordering::SeqCst), 1);
        assert_eq!(client.batch_writes.load(Ordering::SeqCst), 1);
        let writes = client.writes.lock().unwrap();
        let log = writes.iter().find(|w| w.path.ends_with("/log.md")).unwrap();
        assert!(log.content.contains("old entry"));
        assert_eq!(log.expected_etag.as_deref(), Some("old-etag"));
    }

    #[test]
    fn parse_raw_conversation_reads_metadata() {
        let raw = parse_raw_conversation("/Sources/chatgpt/abc.md", RAW).expect("raw should parse");
        assert_eq!(raw.source_id, "chatgpt-abc");
        assert_eq!(raw.provider, "chatgpt");
        assert_eq!(raw.title, "Project Notes");
        assert_eq!(raw.message_count, 2);
    }

    #[test]
    fn parse_raw_conversation_unescapes_quoted_metadata() {
        let raw = parse_raw_conversation(
            "/Sources/chatgpt/abc.md",
            "# Raw Conversation Source\n\n## Metadata\n\n- provider: chatgpt\n- conversation_title: \"Project \\\"Alpha\\\"\"\n- message_count: 1\n",
        )
        .expect("raw should parse");

        assert_eq!(raw.title, "Project \"Alpha\"");
    }

    #[test]
    fn parse_raw_conversation_rejects_unsafe_source_path() {
        let error = parse_raw_conversation("/Sources/../evil.md", RAW)
            .expect_err("unsafe raw path should fail");

        assert!(error.to_string().contains("unsafe segment"));
    }

    #[test]
    fn generated_wiki_does_not_copy_transcript_body() {
        let raw = parse_raw_conversation("/Sources/chatgpt/abc.md", RAW).expect("raw should parse");
        let docs = build_wiki_documents(&raw, "/Knowledge/conversations/chatgpt-abc");
        assert!(docs.iter().any(|doc| doc.path.ends_with("/provenance.md")));
        assert!(docs.iter().all(|doc| !doc.content.contains("secret fact")));
        assert!(docs.iter().all(|doc| !doc.content.contains("answer")));
    }
}
