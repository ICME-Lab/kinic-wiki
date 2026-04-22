// Where: crates/wiki_cli/src/lint_local.rs
// What: Report-only lint checks for the local FS-first mirror.
// Why: Agents still need deterministic local structure checks before pushing mirror changes.
use crate::mirror::{collect_managed_nodes, parse_managed_metadata, strip_frontmatter};
use anyhow::{Context, Result};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

const SHORT_PAGE_THRESHOLD: usize = 40;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalLintIssueKind {
    MissingManagedMetadata,
    EmptyPage,
    ShortPage,
}

impl LocalLintIssueKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::MissingManagedMetadata => "missing_managed_metadata",
            Self::EmptyPage => "empty_page",
            Self::ShortPage => "short_page",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct LocalLintIssue {
    pub kind: LocalLintIssueKind,
    pub path: PathBuf,
    pub message: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct LocalLintReport {
    pub issues: Vec<LocalLintIssue>,
}

pub fn lint_local(mirror_root: &Path) -> Result<LocalLintReport> {
    let mut issues = Vec::new();
    for node in collect_managed_nodes(mirror_root)? {
        let content = fs::read_to_string(&node.path)
            .with_context(|| format!("failed to read {}", node.path.display()))?;
        if parse_managed_metadata(&content).is_none() {
            issues.push(LocalLintIssue {
                kind: LocalLintIssueKind::MissingManagedMetadata,
                path: node.path.clone(),
                message: "managed mirror frontmatter is missing or malformed".to_string(),
            });
            continue;
        }
        let body = strip_frontmatter(&content).trim().to_string();
        if body.is_empty() {
            issues.push(LocalLintIssue {
                kind: LocalLintIssueKind::EmptyPage,
                path: node.path.clone(),
                message: "page body is empty".to_string(),
            });
            continue;
        }
        if body.chars().count() < SHORT_PAGE_THRESHOLD {
            issues.push(LocalLintIssue {
                kind: LocalLintIssueKind::ShortPage,
                path: node.path.clone(),
                message: "page body is very short".to_string(),
            });
        }
    }
    Ok(LocalLintReport { issues })
}

pub fn print_local_lint_report(report: &LocalLintReport, json: bool) -> Result<()> {
    if json {
        println!("{}", serde_json::to_string_pretty(report)?);
        return Ok(());
    }
    if report.issues.is_empty() {
        println!("lint-local: no issues");
        return Ok(());
    }
    for issue in &report.issues {
        println!(
            "{}\t{}\t{}",
            issue.kind.as_str(),
            issue.path.display(),
            issue.message
        );
    }
    Ok(())
}
