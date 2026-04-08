// Where: crates/wiki_cli/src/generate.rs
// What: High-level draft generation flow for local markdown inputs.
// Why: Agents need one command that turns local source files into review-ready Wiki/ drafts.
use crate::cli::{GenerateModeArg, GenerateOutputArg};
use crate::client::WikiApi;
use crate::generate_helpers::{
    describe_page, first_heading, infer_page_type, slugify, split_first_heading, titleize_slug,
};
use crate::mirror::{classify_local_draft_target, write_draft_page};
use anyhow::{Context, Result, anyhow};
use serde::Serialize;
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use wiki_types::{SearchRequest, WikiPageType};

#[derive(Debug)]
pub struct GenerateDraftRequest {
    pub vault_path: PathBuf,
    pub mirror_root: String,
    pub inputs: Vec<PathBuf>,
    pub mode: GenerateModeArg,
    pub output: GenerateOutputArg,
}

#[derive(Debug, Clone, Serialize)]
pub struct PageMapEntry {
    pub slug: String,
    pub title: String,
    pub page_type: WikiPageType,
    pub source_inputs: Vec<PathBuf>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DraftResult {
    pub slug: String,
    pub path: PathBuf,
    pub action: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct GenerateDraftResponse {
    pub page_map: Vec<PageMapEntry>,
    pub draft_results: Vec<DraftResult>,
    pub open_questions: Vec<String>,
}

#[derive(Debug, Clone)]
struct InputDocument {
    path: PathBuf,
    markdown: String,
}

pub async fn generate_draft(
    client: &impl WikiApi,
    request: GenerateDraftRequest,
) -> Result<GenerateDraftResponse> {
    if request.mode == GenerateModeArg::GraphAssisted {
        return Err(anyhow!(
            "graph-assisted mode is not implemented yet; use --mode direct"
        ));
    }
    if request.output != GenerateOutputArg::LocalDraft {
        return Err(anyhow!("only --output local-draft is currently supported"));
    }

    let mirror_root = request.vault_path.join(&request.mirror_root);
    let documents = load_input_documents(&request.inputs)?;
    let page_map = build_page_map(&documents);
    reject_duplicate_slugs(&page_map)?;
    let mut open_questions = collect_local_open_questions(&page_map);
    open_questions.extend(collect_remote_open_questions(client, &page_map).await?);
    let draft_results = write_drafts(&mirror_root, &page_map, &documents)?;

    Ok(GenerateDraftResponse {
        page_map,
        draft_results,
        open_questions,
    })
}

fn load_input_documents(inputs: &[PathBuf]) -> Result<Vec<InputDocument>> {
    let mut documents = Vec::new();
    for path in inputs {
        let markdown = fs::read_to_string(path)
            .with_context(|| format!("failed to read input {}", path.display()))?;
        documents.push(InputDocument {
            path: path.clone(),
            markdown,
        });
    }
    Ok(documents)
}

fn build_page_map(documents: &[InputDocument]) -> Vec<PageMapEntry> {
    let mut page_map = Vec::new();
    for document in documents {
        let stem = file_stem(&document.path);
        let title = first_heading(&document.markdown).unwrap_or_else(|| titleize_slug(&stem));
        let slug = slugify(&stem);
        let page_type = infer_page_type(&stem, &title, &document.markdown);
        page_map.push(PageMapEntry {
            slug,
            title,
            page_type,
            source_inputs: vec![document.path.clone()],
        });
    }

    if documents.len() > 1 {
        let overview_slug = build_overview_slug(documents);
        page_map.insert(
            0,
            PageMapEntry {
                slug: overview_slug.clone(),
                title: titleize_slug(&overview_slug),
                page_type: WikiPageType::Overview,
                source_inputs: documents
                    .iter()
                    .map(|document| document.path.clone())
                    .collect(),
            },
        );
    }

    page_map
}

fn reject_duplicate_slugs(page_map: &[PageMapEntry]) -> Result<()> {
    let mut entries_by_slug = BTreeMap::<String, Vec<Vec<PathBuf>>>::new();
    for entry in page_map {
        entries_by_slug
            .entry(entry.slug.clone())
            .or_default()
            .push(entry.source_inputs.clone());
    }

    let collisions = entries_by_slug
        .into_iter()
        .filter_map(|(slug, groups)| {
            (groups.len() > 1).then(|| {
                let mut unique = groups.into_iter().flatten().collect::<Vec<_>>();
                unique.sort();
                unique.dedup();
                format!(
                    "{slug}: {}",
                    unique
                        .iter()
                        .map(|path| path.display().to_string())
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            })
        })
        .collect::<Vec<_>>();
    if collisions.is_empty() {
        return Ok(());
    }

    Err(anyhow!(
        "duplicate slug generated from multiple inputs; resolve collisions before writing drafts: {}",
        collisions.join("; ")
    ))
}

fn collect_local_open_questions(page_map: &[PageMapEntry]) -> Vec<String> {
    let mut seen_slugs = HashSet::<String>::new();
    let mut seen_titles = HashSet::<String>::new();
    let mut questions = Vec::new();
    for entry in page_map {
        if !seen_slugs.insert(entry.slug.clone()) {
            questions.push(format!(
                "exact slug collision in local draft set: {}",
                entry.slug
            ));
        }
        if !seen_titles.insert(entry.title.to_ascii_lowercase()) {
            questions.push(format!(
                "title collision in local draft set: {}",
                entry.title
            ));
        }
    }
    questions
}

async fn collect_remote_open_questions(
    client: &impl WikiApi,
    page_map: &[PageMapEntry],
) -> Result<Vec<String>> {
    let mut questions = Vec::new();
    for entry in page_map {
        let slug_hits = client
            .search(SearchRequest {
                query_text: entry.slug.clone(),
                page_types: Vec::new(),
                top_k: 5,
            })
            .await?;
        if slug_hits.iter().any(|hit| hit.slug == entry.slug) {
            questions.push(format!(
                "exact slug collision with remote page: {}",
                entry.slug
            ));
            continue;
        }
        let title_hits = client
            .search(SearchRequest {
                query_text: entry.title.clone(),
                page_types: Vec::new(),
                top_k: 5,
            })
            .await?;
        if title_hits.iter().any(|hit| hit.title == entry.title) {
            questions.push(format!("title collision with remote page: {}", entry.title));
            continue;
        }
        if slug_hits
            .iter()
            .chain(title_hits.iter())
            .any(|hit| hit.slug != entry.slug && hit.title != entry.title)
        {
            questions.push(format!(
                "possible overlap with remote pages near '{}' / '{}'",
                entry.slug, entry.title
            ));
        }
    }
    Ok(questions)
}

fn write_drafts(
    mirror_root: &Path,
    page_map: &[PageMapEntry],
    documents: &[InputDocument],
) -> Result<Vec<DraftResult>> {
    let known_slugs = page_map
        .iter()
        .map(|entry| entry.slug.clone())
        .collect::<HashSet<_>>();
    let mut results = Vec::new();
    for entry in page_map {
        let path = mirror_root.join("pages").join(format!("{}.md", entry.slug));
        let action = classify_local_draft_target(&path, "generate-draft")?;
        let markdown = if entry.page_type == WikiPageType::Overview {
            render_overview_page(entry, page_map)
        } else {
            let document = documents
                .iter()
                .find(|document| document.path == entry.source_inputs[0])
                .ok_or_else(|| anyhow!("missing input for draft {}", entry.slug))?;
            render_source_page(entry, &document.markdown)
        };
        let written_path = write_draft_page(
            mirror_root,
            &entry.slug,
            &entry.title,
            entry.page_type.as_str(),
            &markdown,
            &known_slugs,
        )?;
        results.push(DraftResult {
            slug: entry.slug.clone(),
            path: written_path,
            action,
        });
    }
    Ok(results)
}

fn render_overview_page(entry: &PageMapEntry, page_map: &[PageMapEntry]) -> String {
    let mut body = format!("# {}\n\n", entry.title);
    body.push_str("## Draft Page Map\n\n");
    for page in page_map.iter().filter(|page| page.slug != entry.slug) {
        body.push_str(&format!(
            "- [[{}]] — {}\n",
            page.slug,
            describe_page(&page.title, &page.page_type)
        ));
    }
    body
}

fn render_source_page(entry: &PageMapEntry, markdown: &str) -> String {
    let trimmed = markdown.trim();
    let intro = format!(
        "This draft captures the main points about {} for review.",
        entry.title
    );
    if let Some((heading, rest)) = split_first_heading(trimmed) {
        if rest.trim().is_empty() {
            return format!("{heading}\n\n{intro}\n");
        }
        return format!("{heading}\n\n{intro}\n\n{}", rest.trim_start());
    }
    format!("# {}\n\n{}\n\n{}", entry.title, intro, trimmed)
}

fn build_overview_slug(documents: &[InputDocument]) -> String {
    let parent_name = documents
        .first()
        .and_then(|document| document.path.parent())
        .and_then(|path| path.file_name())
        .and_then(|value| value.to_str())
        .map(slugify)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "draft-overview".to_string());
    format!("{parent_name}-overview")
}

fn file_stem(path: &Path) -> String {
    path.file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("draft")
        .to_string()
}
