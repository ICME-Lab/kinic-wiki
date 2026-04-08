// Where: crates/wiki_cli/src/ingest.rs
// What: Raw source ingestion flow for local markdown files.
// Why: Agents need a minimal path to persist raw source material before draft generation.
use crate::client::WikiApi;
use anyhow::{Context, Result};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use wiki_types::CreateSourceInput;

const SOURCE_TYPE: &str = "markdown_note";
const MARKDOWN_MIME_TYPE: &str = "text/markdown";

#[derive(Debug)]
pub struct IngestSourcesRequest {
    pub inputs: Vec<PathBuf>,
}

#[derive(Debug, Clone, Serialize)]
pub struct IngestedSource {
    pub input_path: PathBuf,
    pub source_id: String,
    pub sha256: String,
    pub title: String,
    pub action: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RejectedSource {
    pub input_path: PathBuf,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct IngestSourcesResponse {
    pub ingested: Vec<IngestedSource>,
    pub rejected: Vec<RejectedSource>,
}

pub async fn ingest_sources(
    client: &impl WikiApi,
    request: IngestSourcesRequest,
) -> Result<IngestSourcesResponse> {
    let mut ingested = Vec::new();
    let mut rejected = Vec::new();

    for input_path in request.inputs {
        match ingest_one(client, &input_path).await {
            Ok(entry) => ingested.push(entry),
            Err(error) => rejected.push(RejectedSource {
                input_path,
                reason: error.to_string(),
            }),
        }
    }

    Ok(IngestSourcesResponse { ingested, rejected })
}

async fn ingest_one(client: &impl WikiApi, input_path: &Path) -> Result<IngestedSource> {
    validate_markdown_path(input_path)?;
    let body_text = fs::read_to_string(input_path)
        .with_context(|| format!("failed to read input {}", input_path.display()))?;
    if body_text.trim().is_empty() {
        anyhow::bail!("markdown input is empty");
    }

    let title = first_heading(&body_text).unwrap_or_else(|| titleize_path(input_path));
    let sha256 = sha256_hex(&body_text);
    let metadata_json = serde_json::json!({
        "local_path": input_path.display().to_string(),
    })
    .to_string();
    let source_id = client
        .create_source(CreateSourceInput {
            source_type: SOURCE_TYPE.to_string(),
            title: Some(title.clone()),
            canonical_uri: None,
            sha256: sha256.clone(),
            mime_type: Some(MARKDOWN_MIME_TYPE.to_string()),
            imported_at: now_unix_seconds(),
            metadata_json,
            body_text,
        })
        .await?;

    Ok(IngestedSource {
        input_path: input_path.to_path_buf(),
        source_id,
        sha256,
        title,
        action: "ingested".to_string(),
    })
}

fn validate_markdown_path(input_path: &Path) -> Result<()> {
    if input_path.extension().and_then(|value| value.to_str()) != Some("md") {
        anyhow::bail!("only .md inputs are supported");
    }
    Ok(())
}

fn first_heading(markdown: &str) -> Option<String> {
    markdown.lines().find_map(|line| {
        line.strip_prefix("# ")
            .map(|value| value.trim().to_string())
    })
}

fn titleize_path(path: &Path) -> String {
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("source");
    stem.split('-')
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

fn sha256_hex(text: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(text.as_bytes());
    hex::encode(hasher.finalize())
}

fn now_unix_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}
