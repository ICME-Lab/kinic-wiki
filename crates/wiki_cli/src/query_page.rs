// Where: crates/wiki_cli/src/query_page.rs
// What: Review-first draft generation for query and comparison results.
// Why: Agents need a dedicated path to turn investigation output into new wiki draft pages.
use crate::client::WikiApi;
use crate::generate_helpers::{infer_page_type, slugify};
use crate::mirror::{classify_local_draft_target, parse_draft_metadata, write_draft_page};
use anyhow::{Context, Result, anyhow};
use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use wiki_types::{SearchRequest, WikiPageType};

#[derive(Debug)]
pub struct QueryToPageRequest {
    pub vault_path: PathBuf,
    pub mirror_root: String,
    pub input: PathBuf,
    pub title: String,
    pub slug: Option<String>,
    pub page_type: Option<WikiPageType>,
}

#[derive(Debug, Clone, Serialize)]
pub struct QueryToPageResponse {
    pub slug: String,
    pub title: String,
    pub page_type: WikiPageType,
    pub path: PathBuf,
    pub action: String,
    pub open_questions: Vec<String>,
}

#[derive(Debug, Clone)]
struct ResolvedRemotePage {
    slug: String,
    title: String,
}

pub async fn query_to_page(
    client: &impl WikiApi,
    request: QueryToPageRequest,
) -> Result<QueryToPageResponse> {
    let input_markdown = fs::read_to_string(&request.input)
        .with_context(|| format!("failed to read input {}", request.input.display()))?;
    if input_markdown.trim().is_empty() {
        return Err(anyhow!("query input is empty: {}", request.input.display()));
    }

    let mirror_root = request.vault_path.join(&request.mirror_root);
    let slug = request
        .slug
        .map(|value| slugify(&value))
        .unwrap_or_else(|| slugify(&request.title));
    if slug.is_empty() {
        return Err(anyhow!("query title does not produce a valid slug"));
    }

    let page_type = request
        .page_type
        .unwrap_or_else(|| infer_query_page_type(&request.title, &input_markdown));
    let existing_path = mirror_root.join("pages").join(format!("{slug}.md"));
    let action = classify_local_draft_target(&existing_path, "query-to-page")?;
    let known_slugs = collect_known_slugs(&mirror_root, &slug)?;
    let mut open_questions = collect_local_open_questions(&mirror_root, &slug, &request.title)?;
    let remote_pages = collect_remote_pages(client, &slug, &request.title).await?;
    if remote_pages.iter().any(|page| page.slug == slug) {
        return Err(anyhow!(
            "remote page already exists with slug '{slug}'; review or update the existing page instead"
        ));
    }
    open_questions.extend(remote_open_questions(&slug, &request.title, &remote_pages));

    let markdown = render_query_page(&request.title, &input_markdown, &remote_pages);
    let path = write_draft_page(
        &mirror_root,
        &slug,
        &request.title,
        page_type.as_str(),
        &markdown,
        &known_slugs,
    )?;

    Ok(QueryToPageResponse {
        slug,
        title: request.title,
        page_type,
        path,
        action,
        open_questions,
    })
}

pub fn print_query_to_page_response(response: &QueryToPageResponse, json: bool) -> Result<()> {
    if json {
        println!("{}", serde_json::to_string_pretty(response)?);
        return Ok(());
    }

    println!(
        "query page: {} ({}) [{}]",
        response.slug,
        response.title,
        response.page_type.as_str()
    );
    println!("- {} ({})", response.path.display(), response.action);
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

fn infer_query_page_type(title: &str, markdown: &str) -> WikiPageType {
    match infer_page_type(title, title, markdown) {
        WikiPageType::Comparison => WikiPageType::Comparison,
        _ => WikiPageType::QueryNote,
    }
}

fn collect_known_slugs(mirror_root: &Path, target_slug: &str) -> Result<HashSet<String>> {
    let mut slugs = HashSet::from([target_slug.to_string()]);
    let pages_dir = mirror_root.join("pages");
    if !pages_dir.exists() {
        return Ok(slugs);
    }
    for entry in fs::read_dir(&pages_dir)
        .with_context(|| format!("failed to read {}", pages_dir.display()))?
    {
        let path = entry?.path();
        if path.extension().and_then(|value| value.to_str()) != Some("md") {
            continue;
        }
        if let Some(stem) = path.file_stem().and_then(|value| value.to_str()) {
            slugs.insert(stem.to_string());
        }
    }
    Ok(slugs)
}

fn collect_local_open_questions(
    mirror_root: &Path,
    target_slug: &str,
    target_title: &str,
) -> Result<Vec<String>> {
    let mut questions = Vec::new();
    let pages_dir = mirror_root.join("pages");
    if !pages_dir.exists() {
        return Ok(questions);
    }
    for entry in fs::read_dir(&pages_dir)
        .with_context(|| format!("failed to read {}", pages_dir.display()))?
    {
        let path = entry?.path();
        if path.extension().and_then(|value| value.to_str()) != Some("md") {
            continue;
        }
        let content = fs::read_to_string(&path)
            .with_context(|| format!("failed to read {}", path.display()))?;
        if let Some(metadata) = parse_draft_metadata(&content) {
            if metadata.slug != target_slug && metadata.title.eq_ignore_ascii_case(target_title) {
                questions.push(format!(
                    "title collision in local drafts: {}",
                    metadata.title
                ));
            }
        }
    }
    Ok(questions)
}

async fn collect_remote_pages(
    client: &impl WikiApi,
    slug: &str,
    title: &str,
) -> Result<Vec<ResolvedRemotePage>> {
    let slug_hits = client
        .search(SearchRequest {
            query_text: slug.to_string(),
            page_types: Vec::new(),
            top_k: 5,
        })
        .await?;
    let title_hits = client
        .search(SearchRequest {
            query_text: title.to_string(),
            page_types: Vec::new(),
            top_k: 5,
        })
        .await?;

    let mut seen = HashSet::new();
    let mut merged = Vec::new();
    for hit in slug_hits.into_iter().chain(title_hits) {
        if !seen.insert(hit.slug.clone()) {
            continue;
        }
        if let Some(page) = client.get_page(&hit.slug).await? {
            merged.push(ResolvedRemotePage {
                slug: page.slug,
                title: page.title,
            });
        } else {
            merged.push(ResolvedRemotePage {
                slug: hit.slug,
                title: hit.title,
            });
        }
    }
    Ok(merged)
}

fn remote_open_questions(slug: &str, title: &str, pages: &[ResolvedRemotePage]) -> Vec<String> {
    let mut questions = Vec::new();
    if pages.iter().any(|page| page.slug == slug) {
        questions.push(format!("exact slug collision with remote page: {slug}"));
        return questions;
    }
    if pages.iter().any(|page| page.title == title) {
        questions.push(format!("title collision with remote page: {title}"));
        return questions;
    }
    if let Some(page) = pages.first() {
        questions.push(format!(
            "possible overlap with remote page: {} ({})",
            page.slug, page.title
        ));
    }
    questions
}

fn render_query_page(title: &str, input_markdown: &str, pages: &[ResolvedRemotePage]) -> String {
    let body = if let Some((_heading, remaining)) =
        crate::generate_helpers::split_first_heading(input_markdown)
    {
        remaining.trim()
    } else {
        input_markdown.trim()
    };

    let mut markdown = format!(
        "# {title}\n\nThis draft captures a query-driven synthesis that should be reviewed before adoption.\n\n## Query Result\n\n{}\n",
        body
    );
    if !pages.is_empty() {
        markdown.push_str("\n## Related Pages\n\n");
        for page in pages {
            markdown.push_str(&format!("- [[{}]] — {}\n", page.slug, page.title));
        }
    }
    markdown
}
