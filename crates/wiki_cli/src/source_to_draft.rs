// Where: crates/wiki_cli/src/source_to_draft.rs
// What: High-level wrapper from source files to review-ready local drafts.
// Why: Agents need one clear source-oriented entry point instead of manually chaining commands.
use crate::cli::{GenerateModeArg, GenerateOutputArg};
use crate::client::WikiApi;
use crate::generate::{DraftResult, GenerateDraftRequest, PageMapEntry, generate_draft};
use crate::ingest::{IngestSourcesRequest, IngestedSource, RejectedSource, ingest_sources};
use anyhow::Result;
use serde::Serialize;
use std::path::PathBuf;

#[derive(Debug)]
pub struct SourceToDraftRequest {
    pub vault_path: PathBuf,
    pub mirror_root: String,
    pub inputs: Vec<PathBuf>,
    pub persist_sources: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct SourceToDraftResponse {
    pub persisted_sources: Vec<IngestedSource>,
    pub rejected_sources: Vec<RejectedSource>,
    pub page_map: Vec<PageMapEntry>,
    pub draft_results: Vec<DraftResult>,
    pub open_questions: Vec<String>,
}

pub async fn source_to_draft(
    client: &impl WikiApi,
    request: SourceToDraftRequest,
) -> Result<SourceToDraftResponse> {
    let (persisted_sources, rejected_sources) = if request.persist_sources {
        let ingest_response = ingest_sources(
            client,
            IngestSourcesRequest {
                inputs: request.inputs.clone(),
            },
        )
        .await?;
        (ingest_response.ingested, ingest_response.rejected)
    } else {
        (Vec::new(), Vec::new())
    };

    if !rejected_sources.is_empty() {
        return Ok(SourceToDraftResponse {
            persisted_sources,
            rejected_sources,
            page_map: Vec::new(),
            draft_results: Vec::new(),
            open_questions: Vec::new(),
        });
    }

    let generate_response = generate_draft(
        client,
        GenerateDraftRequest {
            vault_path: request.vault_path,
            mirror_root: request.mirror_root,
            inputs: request.inputs,
            mode: GenerateModeArg::Direct,
            output: GenerateOutputArg::LocalDraft,
        },
    )
    .await?;

    Ok(SourceToDraftResponse {
        persisted_sources,
        rejected_sources,
        page_map: generate_response.page_map,
        draft_results: generate_response.draft_results,
        open_questions: generate_response.open_questions,
    })
}

pub fn print_source_to_draft_response(response: &SourceToDraftResponse, json: bool) -> Result<()> {
    if json {
        println!("{}", serde_json::to_string_pretty(response)?);
        return Ok(());
    }

    if response.persisted_sources.is_empty() {
        println!("persisted sources: none");
    } else {
        println!("persisted sources:");
        for entry in &response.persisted_sources {
            println!(
                "- {} -> {} ({})",
                entry.input_path.display(),
                entry.source_id,
                entry.action
            );
        }
    }
    if response.rejected_sources.is_empty() {
        println!("rejected sources: none");
    } else {
        println!("rejected sources:");
        for entry in &response.rejected_sources {
            println!("- {} ({})", entry.input_path.display(), entry.reason);
        }
    }

    if !response.rejected_sources.is_empty() {
        return Ok(());
    }

    println!("page map:");
    for entry in &response.page_map {
        println!(
            "- {} ({}) [{}]",
            entry.slug,
            entry.title,
            entry.page_type.as_str()
        );
    }
    println!("draft results:");
    for result in &response.draft_results {
        println!(
            "- {} -> {} ({})",
            result.slug,
            result.path.display(),
            result.action
        );
    }
    if response.open_questions.is_empty() {
        println!("open questions: none");
    } else {
        println!("open questions:");
        for question in &response.open_questions {
            println!("- {question}");
        }
    }
    Ok(())
}
