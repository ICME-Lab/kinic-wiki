// Where: crates/wiki_cli/src/lint_local.rs
// What: Report-only lint checks for the local Wiki/ working copy.
// Why: Agents need deterministic local structure checks before adopt-draft and push.
use crate::mirror::{parse_draft_metadata, parse_managed_metadata, strip_frontmatter};
use anyhow::{Context, Result};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

const SHORT_PAGE_THRESHOLD: usize = 40;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalLintIssueKind {
    MissingDraftMetadata,
    MissingManagedMetadata,
    DuplicateSlug,
    DuplicateTitle,
    BrokenWikilink,
    EmptyPage,
    ShortPage,
}

impl LocalLintIssueKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::MissingDraftMetadata => "missing_draft_metadata",
            Self::MissingManagedMetadata => "missing_managed_metadata",
            Self::DuplicateSlug => "duplicate_slug",
            Self::DuplicateTitle => "duplicate_title",
            Self::BrokenWikilink => "broken_wikilink",
            Self::EmptyPage => "empty_page",
            Self::ShortPage => "short_page",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct LocalLintIssue {
    pub kind: LocalLintIssueKind,
    pub path: PathBuf,
    pub slug: Option<String>,
    pub message: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct LocalLintReport {
    pub issues: Vec<LocalLintIssue>,
}

#[derive(Clone, Debug)]
struct LocalPageFile {
    path: PathBuf,
    declared_slug: Option<String>,
    title: Option<String>,
    body: String,
}

pub fn lint_local(mirror_root: &Path) -> Result<LocalLintReport> {
    let files = collect_page_files(mirror_root)?;
    let known_slugs = files
        .iter()
        .filter_map(|file| file.declared_slug.clone())
        .collect::<HashSet<_>>();
    let mut issues = collect_duplicate_issues(&files);
    for file in &files {
        issues.extend(classify_file_issues(file, &known_slugs));
    }
    Ok(LocalLintReport { issues })
}

pub fn print_local_lint_report(report: &LocalLintReport, json: bool) -> Result<()> {
    if json {
        println!("{}", serde_json::to_string_pretty(report)?);
        return Ok(());
    }
    let output = render_local_lint_report(report);
    println!("{output}");
    Ok(())
}

pub fn render_local_lint_report(report: &LocalLintReport) -> String {
    if report.issues.is_empty() {
        return "lint-local: no issues".to_string();
    }
    report
        .issues
        .iter()
        .map(|issue| {
            format!(
                "{}\t{}\t{}\t{}",
                issue.kind.as_str(),
                issue.path.display(),
                issue.slug.as_deref().unwrap_or("-"),
                issue.message
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn collect_page_files(mirror_root: &Path) -> Result<Vec<LocalPageFile>> {
    let pages_dir = mirror_root.join("pages");
    if !pages_dir.exists() {
        return Ok(Vec::new());
    }
    let mut files = Vec::new();
    for entry in fs::read_dir(&pages_dir)
        .with_context(|| format!("failed to read {}", pages_dir.display()))?
    {
        let path = entry?.path();
        if path.extension().and_then(|value| value.to_str()) != Some("md") {
            continue;
        }
        let content = fs::read_to_string(&path)
            .with_context(|| format!("failed to read {}", path.display()))?;
        let body = strip_frontmatter(&content).trim().to_string();
        let declared_slug;
        let title;
        if let Some(metadata) = parse_managed_metadata(&content) {
            declared_slug = Some(metadata.slug);
            title = first_heading(&body);
        } else if let Some(metadata) = parse_draft_metadata(&content) {
            declared_slug = Some(metadata.slug);
            title = Some(metadata.title);
        } else {
            declared_slug = None;
            title = first_heading(&body);
        }
        files.push(LocalPageFile {
            path,
            declared_slug,
            title,
            body,
        });
    }
    Ok(files)
}

fn collect_duplicate_issues(files: &[LocalPageFile]) -> Vec<LocalLintIssue> {
    let mut issues = Vec::new();
    let mut by_slug = HashMap::<String, Vec<&LocalPageFile>>::new();
    let mut by_title = HashMap::<String, Vec<&LocalPageFile>>::new();
    for file in files {
        if let Some(slug) = &file.declared_slug {
            by_slug.entry(slug.clone()).or_default().push(file);
        }
        if let Some(title) = &file.title {
            by_title
                .entry(title.to_ascii_lowercase())
                .or_default()
                .push(file);
        }
    }
    for (slug, matches) in by_slug {
        if matches.len() < 2 {
            continue;
        }
        for file in matches {
            issues.push(LocalLintIssue {
                kind: LocalLintIssueKind::DuplicateSlug,
                path: file.path.clone(),
                slug: Some(slug.clone()),
                message: format!("slug is duplicated in local working copy: {slug}"),
            });
        }
    }
    for (_, matches) in by_title {
        if matches.len() < 2 {
            continue;
        }
        let title = matches[0].title.clone().unwrap_or_default();
        for file in matches {
            issues.push(LocalLintIssue {
                kind: LocalLintIssueKind::DuplicateTitle,
                path: file.path.clone(),
                slug: file.declared_slug.clone(),
                message: format!("title is duplicated in local working copy: {title}"),
            });
        }
    }
    issues
}

fn classify_file_issues(
    file: &LocalPageFile,
    known_slugs: &HashSet<String>,
) -> Vec<LocalLintIssue> {
    let mut issues = Vec::new();
    let content = fs::read_to_string(&file.path).unwrap_or_default();
    let managed_metadata = parse_managed_metadata(&content);
    let draft_metadata = parse_draft_metadata(&content);
    if managed_metadata.is_none() && draft_metadata.is_none() {
        let kind = if looks_like_managed_frontmatter(&content) {
            LocalLintIssueKind::MissingManagedMetadata
        } else {
            LocalLintIssueKind::MissingDraftMetadata
        };
        issues.push(LocalLintIssue {
            kind,
            path: file.path.clone(),
            slug: file.declared_slug.clone(),
            message: "frontmatter is present but required metadata is missing or malformed"
                .to_string(),
        });
    }
    if file.body.trim().is_empty() {
        issues.push(LocalLintIssue {
            kind: LocalLintIssueKind::EmptyPage,
            path: file.path.clone(),
            slug: file.declared_slug.clone(),
            message: "page body is empty".to_string(),
        });
        return issues;
    }
    if file.body.chars().count() < SHORT_PAGE_THRESHOLD {
        issues.push(LocalLintIssue {
            kind: LocalLintIssueKind::ShortPage,
            path: file.path.clone(),
            slug: file.declared_slug.clone(),
            message: format!(
                "page body is shorter than {} characters",
                SHORT_PAGE_THRESHOLD
            ),
        });
    }
    for target in extract_wikilinks(&file.body) {
        if !known_slugs.contains(&target) {
            issues.push(LocalLintIssue {
                kind: LocalLintIssueKind::BrokenWikilink,
                path: file.path.clone(),
                slug: file.declared_slug.clone(),
                message: format!("wikilink target does not exist locally: [[{target}]]"),
            });
        }
    }
    issues
}

fn looks_like_managed_frontmatter(content: &str) -> bool {
    ["page_id:", "revision_id:", "mirror:"]
        .iter()
        .any(|needle| content.contains(needle))
}

fn extract_wikilinks(markdown: &str) -> Vec<String> {
    let mut links = Vec::new();
    let mut offset = 0usize;
    while let Some(start) = markdown[offset..].find("[[") {
        let absolute_start = offset + start + 2;
        let Some(end) = markdown[absolute_start..].find("]]") else {
            break;
        };
        let target = &markdown[absolute_start..absolute_start + end];
        let canonical = canonical_slug(target);
        if !canonical.is_empty() {
            links.push(canonical);
        }
        offset = absolute_start + end + 2;
    }
    links
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

fn first_heading(markdown: &str) -> Option<String> {
    markdown.lines().find_map(|line| {
        line.strip_prefix("# ")
            .map(|value| value.trim().to_string())
    })
}
