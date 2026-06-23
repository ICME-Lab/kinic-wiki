// Where: crates/vfs_cli_app/src/context_pack.rs
// What: OKF-only Context Pack export, verification, and inspection.
// Why: Kinic should emit an interoperable markdown knowledge bundle while preserving Kinic trust metadata as frontmatter extensions.
use anyhow::{Context, Result, anyhow, bail};
use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use vfs_client::VfsApi;
use vfs_types::{ListNodesRequest, Node, NodeEntryKind, NodeKind};
use wiki_domain::{RAW_SOURCES_PREFIX, WIKI_ROOT_PATH};

const OKF_VERSION: &str = "0.1";
const INDEX_FILE: &str = "index.md";
const LOG_FILE: &str = "log.md";

#[derive(Debug, Clone)]
pub struct ContextPackExportOptions {
    pub root: String,
    pub out: PathBuf,
    pub expires_at: String,
    pub trust_level: String,
    pub approved_by: Vec<String>,
    pub overwrite: bool,
    pub json: bool,
}

#[derive(Debug, Clone)]
pub struct ContextPackVerifyOptions {
    pub path: PathBuf,
    pub json: bool,
}

#[derive(Debug, Clone)]
pub struct ContextPackInspectOptions {
    pub path: PathBuf,
    pub json: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OkfExportResult {
    pub out: String,
    pub okf_version: String,
    pub concept_count: usize,
    pub reference_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OkfVerifyResult {
    pub path: String,
    pub valid: bool,
    pub errors: Vec<String>,
    pub concept_count: usize,
    pub reference_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OkfInspectResult {
    pub path: String,
    pub okf_version: String,
    pub concept_count: usize,
    pub types: BTreeMap<String, usize>,
    pub kinic: KinicOkfSummary,
    pub expired_concept_count: usize,
    pub reference_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct KinicOkfSummary {
    pub database_ids: Vec<String>,
    pub roots: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct OkfFrontmatter {
    #[serde(rename = "type")]
    concept_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    resource: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    tags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    timestamp: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    kinic: Option<KinicFrontmatter>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct KinicFrontmatter {
    #[serde(skip_serializing_if = "Option::is_none")]
    database_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    root: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    etag: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    content_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    trust_level: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    approved_by: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    expires_at: Option<String>,
}

#[derive(Debug, Clone)]
struct OkfConcept {
    relative_path: PathBuf,
    frontmatter: OkfFrontmatter,
    body: String,
}

#[derive(Debug, Clone, Copy)]
struct OkfBuildMetadata<'a> {
    database_id: &'a str,
    root: &'a str,
    generated_at: &'a str,
    expires_at: &'a str,
    trust_level: &'a str,
    approved_by: &'a [String],
}

#[derive(Debug, Clone)]
struct BucketedNode {
    node: Node,
    bucket: OkfBucket,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum OkfBucket {
    Fact,
    Decision,
    Task,
    Policy,
    Note,
}

impl OkfBucket {
    fn concept_type(self) -> &'static str {
        match self {
            Self::Fact => "Fact",
            Self::Decision => "Decision",
            Self::Task => "Task",
            Self::Policy => "Policy",
            Self::Note => "Note",
        }
    }

    fn directory(self) -> &'static str {
        match self {
            Self::Fact => "facts",
            Self::Decision => "decisions",
            Self::Task => "tasks",
            Self::Policy => "policies",
            Self::Note => "notes",
        }
    }
}

pub async fn run_context_pack_export(
    client: &impl VfsApi,
    database_id: &str,
    options: ContextPackExportOptions,
) -> Result<()> {
    let result = export_okf_bundle(client, database_id, options.clone()).await?;
    if options.json {
        println!("{}", serde_json::to_string_pretty(&result)?);
    } else {
        println!(
            "okf bundle exported: {} ({} concepts, {} references)",
            result.out, result.concept_count, result.reference_count
        );
    }
    Ok(())
}

pub fn run_context_pack_verify(options: ContextPackVerifyOptions) -> Result<()> {
    let result = verify_okf_bundle_dir(&options.path)?;
    if options.json {
        println!("{}", serde_json::to_string_pretty(&result)?);
    } else if result.valid {
        println!("okf bundle valid: {}", result.path);
    } else {
        println!("okf bundle invalid: {}", result.path);
        for error in &result.errors {
            println!("- {error}");
        }
    }
    if result.valid {
        Ok(())
    } else {
        bail!("okf bundle verification failed")
    }
}

pub fn run_context_pack_inspect(options: ContextPackInspectOptions) -> Result<()> {
    let result = inspect_okf_bundle_dir(&options.path)?;
    if options.json {
        println!("{}", serde_json::to_string_pretty(&result)?);
    } else {
        println!("okf_version: {}", result.okf_version);
        println!("concept_count: {}", result.concept_count);
        println!("reference_count: {}", result.reference_count);
        println!("expired_concept_count: {}", result.expired_concept_count);
        println!("database_ids: {}", result.kinic.database_ids.join(", "));
        println!("roots: {}", result.kinic.roots.join(", "));
    }
    Ok(())
}

async fn export_okf_bundle(
    client: &impl VfsApi,
    database_id: &str,
    options: ContextPackExportOptions,
) -> Result<OkfExportResult> {
    let root = normalize_wiki_root(&options.root)?;
    parse_timestamp(&options.expires_at).context("expires_at must be RFC3339")?;
    ensure_output_dir(&options.out, options.overwrite)?;

    let generated_at = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
    let wiki_nodes = collect_wiki_nodes(client, database_id, &root).await?;
    let source_paths = collect_source_refs(&wiki_nodes);
    let source_nodes = collect_sources(client, database_id, &source_paths).await?;
    let metadata = OkfBuildMetadata {
        database_id,
        root: &root,
        generated_at: &generated_at,
        expires_at: &options.expires_at,
        trust_level: &options.trust_level,
        approved_by: &options.approved_by,
    };
    let concepts = build_okf_concepts(metadata, &wiki_nodes, &source_nodes);

    write_okf_bundle(&options.out, &root, &generated_at, &concepts)?;

    Ok(OkfExportResult {
        out: options.out.display().to_string(),
        okf_version: OKF_VERSION.to_string(),
        concept_count: concepts.len(),
        reference_count: source_nodes.len(),
    })
}

pub fn verify_okf_bundle_dir(path: &Path) -> Result<OkfVerifyResult> {
    let mut errors = Vec::new();
    let mut concept_count = 0;
    let mut reference_count = 0;
    for file in collect_markdown_files(path)? {
        let relative = file.strip_prefix(path).unwrap_or(&file);
        if is_reserved_markdown(relative) {
            if starts_with_frontmatter(&file)? {
                errors.push(format!(
                    "reserved file must not use frontmatter: {}",
                    relative.display()
                ));
            }
            continue;
        }
        let frontmatter = match read_okf_frontmatter(&file) {
            Ok(frontmatter) => frontmatter,
            Err(error) => {
                errors.push(format!("{}: {error}", relative.display()));
                continue;
            }
        };
        concept_count += 1;
        let is_reference =
            frontmatter.concept_type == "Reference" || path_has_component(relative, "references");
        if is_reference {
            reference_count += 1;
        }
        if frontmatter.concept_type.trim().is_empty() {
            errors.push(format!("{}: type is required", relative.display()));
        }
        if let Some(kinic) = &frontmatter.kinic {
            if !is_reference && let Some(expected_hash) = &kinic.content_hash {
                match okf_body_text(&file) {
                    Ok(body) => {
                        let actual_hash = sha256_hex(body.as_bytes());
                        if expected_hash != &actual_hash {
                            errors.push(format!(
                                "{}: kinic.content_hash mismatch",
                                relative.display()
                            ));
                        }
                    }
                    Err(error) => errors.push(format!(
                        "{}: failed to verify kinic.content_hash: {error}",
                        relative.display()
                    )),
                }
            }
            if let Some(expires_at) = &kinic.expires_at {
                match parse_timestamp(expires_at) {
                    Ok(value) if value <= Utc::now() => errors.push(format!(
                        "{}: kinic.expires_at is not in the future",
                        relative.display()
                    )),
                    Ok(_) => {}
                    Err(error) => errors.push(format!(
                        "{}: kinic.expires_at is invalid: {error}",
                        relative.display()
                    )),
                }
            }
            if is_reference {
                match &kinic.source_path {
                    Some(source_path) if path_under_prefix(source_path, RAW_SOURCES_PREFIX) => {}
                    Some(source_path) => errors.push(format!(
                        "{}: kinic.source_path is outside {RAW_SOURCES_PREFIX}: {source_path}",
                        relative.display()
                    )),
                    None => errors.push(format!(
                        "{}: references concept requires kinic.source_path",
                        relative.display()
                    )),
                }
            }
        } else if is_reference {
            errors.push(format!(
                "{}: reference concept requires kinic.source_path",
                relative.display()
            ));
        }
    }

    Ok(OkfVerifyResult {
        path: path.display().to_string(),
        valid: errors.is_empty(),
        errors,
        concept_count,
        reference_count,
    })
}

pub fn inspect_okf_bundle_dir(path: &Path) -> Result<OkfInspectResult> {
    let mut types = BTreeMap::<String, usize>::new();
    let mut database_ids = BTreeSet::<String>::new();
    let mut roots = BTreeSet::<String>::new();
    let mut concept_count = 0;
    let mut reference_count = 0;
    let mut expired_concept_count = 0;
    let now = Utc::now();

    for file in collect_markdown_files(path)? {
        let relative = file.strip_prefix(path).unwrap_or(&file);
        if is_reserved_markdown(relative) {
            continue;
        }
        let frontmatter = read_okf_frontmatter(&file)
            .with_context(|| format!("failed to inspect {}", relative.display()))?;
        concept_count += 1;
        *types.entry(frontmatter.concept_type.clone()).or_insert(0) += 1;
        if frontmatter.concept_type == "Reference" || path_has_component(relative, "references") {
            reference_count += 1;
        }
        if let Some(kinic) = frontmatter.kinic {
            if let Some(database_id) = kinic.database_id {
                database_ids.insert(database_id);
            }
            if let Some(root) = kinic.root {
                roots.insert(root);
            }
            if let Some(expires_at) = kinic.expires_at
                && parse_timestamp(&expires_at).is_ok_and(|value| value <= now)
            {
                expired_concept_count += 1;
            }
        }
    }

    Ok(OkfInspectResult {
        path: path.display().to_string(),
        okf_version: OKF_VERSION.to_string(),
        concept_count,
        types,
        kinic: KinicOkfSummary {
            database_ids: database_ids.into_iter().collect(),
            roots: roots.into_iter().collect(),
        },
        expired_concept_count,
        reference_count,
    })
}

async fn collect_wiki_nodes(
    client: &impl VfsApi,
    database_id: &str,
    root: &str,
) -> Result<Vec<BucketedNode>> {
    let entries = client
        .list_nodes(ListNodesRequest {
            database_id: database_id.to_string(),
            prefix: root.to_string(),
            recursive: true,
        })
        .await?;
    let mut paths = entries
        .into_iter()
        .filter(|entry| matches!(entry.kind, NodeEntryKind::File | NodeEntryKind::Source))
        .map(|entry| entry.path)
        .collect::<BTreeSet<_>>();
    if let Some(root_node) = client.read_node(database_id, root).await?
        && matches!(root_node.kind, NodeKind::File | NodeKind::Source)
    {
        paths.insert(root_node.path);
    }

    let mut nodes = Vec::new();
    for path in paths {
        let Some(node) = client.read_node(database_id, &path).await? else {
            continue;
        };
        if !matches!(node.kind, NodeKind::File | NodeKind::Source) {
            continue;
        }
        nodes.push(BucketedNode {
            bucket: bucket_for_path(&node.path),
            node,
        });
    }
    Ok(nodes)
}

async fn collect_sources(
    client: &impl VfsApi,
    database_id: &str,
    source_paths: &BTreeSet<String>,
) -> Result<Vec<Node>> {
    let mut sources = Vec::new();
    for path in source_paths {
        let source = client
            .read_node(database_id, path)
            .await?
            .ok_or_else(|| anyhow!("source_ref does not exist: {path}"))?;
        if source.kind != NodeKind::Source {
            bail!("source_ref is not a source node: {path}");
        }
        sources.push(source);
    }
    Ok(sources)
}

fn build_okf_concepts(
    metadata: OkfBuildMetadata<'_>,
    wiki_nodes: &[BucketedNode],
    source_nodes: &[Node],
) -> Vec<OkfConcept> {
    let mut concepts = Vec::new();
    let mut used_paths = BTreeSet::new();
    for item in wiki_nodes {
        let slug = unique_slug(&item.node.path, &mut used_paths);
        let relative_path = PathBuf::from(item.bucket.directory()).join(format!("{slug}.md"));
        let body = rendered_concept_body(&item.node.content);
        concepts.push(OkfConcept {
            relative_path,
            frontmatter: OkfFrontmatter {
                concept_type: item.bucket.concept_type().to_string(),
                title: Some(title_from_path(&item.node.path)),
                description: Some(format!("Generated from Kinic Wiki node {}", item.node.path)),
                resource: Some(kinic_resource(metadata.database_id, &item.node.path)),
                tags: vec!["kinic".to_string(), item.bucket.directory().to_string()],
                timestamp: Some(metadata.generated_at.to_string()),
                kinic: Some(KinicFrontmatter {
                    database_id: Some(metadata.database_id.to_string()),
                    root: Some(metadata.root.to_string()),
                    source_path: None,
                    etag: Some(item.node.etag.clone()),
                    content_hash: Some(sha256_hex(body.as_bytes())),
                    trust_level: Some(metadata.trust_level.to_string()),
                    approved_by: metadata.approved_by.to_vec(),
                    expires_at: Some(metadata.expires_at.to_string()),
                }),
            },
            body,
        });
    }

    for source in source_nodes {
        let slug = unique_slug(&source.path, &mut used_paths);
        let relative_path = PathBuf::from("references").join(format!("{slug}.md"));
        concepts.push(OkfConcept {
            relative_path,
            frontmatter: OkfFrontmatter {
                concept_type: "Reference".to_string(),
                title: Some(title_from_path(&source.path)),
                description: Some(format!("Kinic raw source reference for {}", source.path)),
                resource: Some(kinic_resource(metadata.database_id, &source.path)),
                tags: vec!["kinic".to_string(), "reference".to_string()],
                timestamp: Some(metadata.generated_at.to_string()),
                kinic: Some(KinicFrontmatter {
                    database_id: Some(metadata.database_id.to_string()),
                    root: Some(metadata.root.to_string()),
                    source_path: Some(source.path.clone()),
                    etag: Some(source.etag.clone()),
                    content_hash: Some(sha256_hex(source.content.as_bytes())),
                    trust_level: Some(metadata.trust_level.to_string()),
                    approved_by: metadata.approved_by.to_vec(),
                    expires_at: Some(metadata.expires_at.to_string()),
                }),
            },
            body: reference_body(source),
        });
    }

    concepts.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    concepts
}

fn write_okf_bundle(
    out: &Path,
    root: &str,
    generated_at: &str,
    concepts: &[OkfConcept],
) -> Result<()> {
    for concept in concepts {
        let path = out.join(&concept.relative_path);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(path, render_concept(concept)?)?;
    }
    fs::write(out.join(INDEX_FILE), render_index(root, concepts))?;
    fs::write(out.join(LOG_FILE), render_log(root, generated_at))?;
    Ok(())
}

fn render_concept(concept: &OkfConcept) -> Result<String> {
    let frontmatter = serde_yaml::to_string(&concept.frontmatter)?;
    Ok(format!(
        "---\n{frontmatter}---\n\n{}\n",
        rendered_concept_body(&concept.body)
    ))
}

fn rendered_concept_body(body: &str) -> String {
    body.trim().to_string()
}

fn render_index(root: &str, concepts: &[OkfConcept]) -> String {
    let mut groups = BTreeMap::<String, Vec<&OkfConcept>>::new();
    for concept in concepts {
        groups
            .entry(concept.frontmatter.concept_type.clone())
            .or_default()
            .push(concept);
    }
    let mut output = format!("# OKF Context Bundle\n\nGenerated from `{root}`.\n");
    for (concept_type, items) in groups {
        output.push_str(&format!("\n## {concept_type}\n\n"));
        for concept in items {
            let title = concept
                .frontmatter
                .title
                .as_deref()
                .unwrap_or("")
                .to_string();
            let title = if title.is_empty() {
                concept.relative_path.to_string_lossy().to_string()
            } else {
                title
            };
            let description = concept
                .frontmatter
                .description
                .as_deref()
                .unwrap_or("")
                .to_string();
            output.push_str(&format!(
                "- [{}]({}) - {}\n",
                title,
                concept.relative_path.to_string_lossy(),
                description
            ));
        }
    }
    output
}

fn render_log(root: &str, generated_at: &str) -> String {
    let date = generated_at.split('T').next().unwrap_or(generated_at);
    format!(
        "# Directory Update Log\n\n## {date}\n\n* **Export**: Generated OKF context bundle from `{root}`.\n"
    )
}

fn reference_body(source: &Node) -> String {
    format!(
        "# Reference\n\n- source_path: `{}`\n- etag: `{}`\n- content_hash: `{}`\n- metadata_json: `{}`\n\nRaw source content is not copied into this OKF bundle.\n",
        source.path,
        source.etag,
        sha256_hex(source.content.as_bytes()),
        source.metadata_json.replace('`', "\\`")
    )
}

fn collect_source_refs(nodes: &[BucketedNode]) -> BTreeSet<String> {
    let mut refs = BTreeSet::new();
    for item in nodes {
        for source_path in extract_raw_source_paths(&item.node.content) {
            refs.insert(source_path);
        }
    }
    refs
}

fn extract_raw_source_paths(content: &str) -> Vec<String> {
    let mut paths = Vec::new();
    let mut offset = 0;
    while let Some(relative_start) = content[offset..].find(RAW_SOURCES_PREFIX) {
        let start = offset + relative_start;
        let tail = &content[start..];
        let end = tail
            .char_indices()
            .find_map(|(index, ch)| source_path_terminator(ch).then_some(index))
            .unwrap_or(tail.len());
        let candidate = tail[..end].trim_end_matches(['.', ',', ';', ':']);
        if !candidate.is_empty() {
            paths.push(candidate.to_string());
        }
        offset = start + end;
    }
    paths
}

fn source_path_terminator(ch: char) -> bool {
    ch.is_whitespace() || matches!(ch, ')' | ']' | '"' | '\'' | '<' | '>' | '`')
}

fn bucket_for_path(path: &str) -> OkfBucket {
    let lower = path.to_ascii_lowercase();
    let file_name = lower.rsplit('/').next().unwrap_or("");
    if file_name == "facts.md" {
        OkfBucket::Fact
    } else if file_name == "decisions.md"
        || file_name == "decision.md"
        || lower.contains("/decisions/")
    {
        OkfBucket::Decision
    } else if file_name == "tasks.md" || file_name == "plans.md" {
        OkfBucket::Task
    } else if file_name == "style-guide.md"
        || file_name == "style_guide.md"
        || file_name == "preferences.md"
        || file_name == "do-not-do.md"
        || file_name == "do_not_do.md"
    {
        OkfBucket::Policy
    } else {
        OkfBucket::Note
    }
}

fn collect_markdown_files(root: &Path) -> Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    collect_markdown_files_inner(root, &mut files)?;
    files.sort();
    Ok(files)
}

fn collect_markdown_files_inner(path: &Path, files: &mut Vec<PathBuf>) -> Result<()> {
    for entry in fs::read_dir(path).with_context(|| format!("failed to read {}", path.display()))? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            collect_markdown_files_inner(&path, files)?;
        } else if path.extension().is_some_and(|extension| extension == "md") {
            files.push(path);
        }
    }
    Ok(())
}

fn read_okf_frontmatter(path: &Path) -> Result<OkfFrontmatter> {
    let text = fs::read_to_string(path)?;
    let frontmatter = frontmatter_text(&text)
        .ok_or_else(|| anyhow!("missing YAML frontmatter delimited by ---"))?;
    Ok(serde_yaml::from_str(frontmatter)?)
}

fn okf_body_text(path: &Path) -> Result<String> {
    let text = fs::read_to_string(path)?;
    let rest = text
        .strip_prefix("---\n")
        .ok_or_else(|| anyhow!("missing YAML frontmatter delimited by ---"))?;
    let end = rest
        .find("\n---")
        .ok_or_else(|| anyhow!("missing YAML frontmatter delimited by ---"))?;
    let body_start = end + "\n---".len();
    let body = rest[body_start..].trim_start_matches('\n');
    Ok(body.trim_end_matches('\n').to_string())
}

fn frontmatter_text(text: &str) -> Option<&str> {
    let rest = text.strip_prefix("---\n")?;
    let end = rest.find("\n---")?;
    Some(&rest[..end])
}

fn starts_with_frontmatter(path: &Path) -> Result<bool> {
    Ok(fs::read_to_string(path)?.starts_with("---\n"))
}

fn is_reserved_markdown(relative: &Path) -> bool {
    relative
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| matches!(name, INDEX_FILE | LOG_FILE))
}

fn path_has_component(path: &Path, expected: &str) -> bool {
    path.components()
        .any(|component| component.as_os_str() == std::ffi::OsStr::new(expected))
}

fn ensure_output_dir(out: &Path, overwrite: bool) -> Result<()> {
    if out.exists() && !out.is_dir() {
        bail!("OKF output path is not a directory: {}", out.display());
    }
    fs::create_dir_all(out)?;
    let existing = collect_markdown_files(out)?;
    if !existing.is_empty() && !overwrite {
        bail!(
            "OKF markdown files already exist in {}; pass --overwrite to replace them",
            out.display()
        );
    }
    if overwrite {
        for file in existing {
            fs::remove_file(file)?;
        }
        for legacy_name in ["manifest.json", "sources.json", "provenance.json"] {
            let legacy_path = out.join(legacy_name);
            if legacy_path.exists() {
                fs::remove_file(legacy_path)?;
            }
        }
    }
    Ok(())
}

fn normalize_wiki_root(root: &str) -> Result<String> {
    let trimmed = root.trim();
    if !path_under_prefix(trimmed, WIKI_ROOT_PATH) {
        bail!("context pack root must stay under {WIKI_ROOT_PATH}: {root}");
    }
    if trimmed == WIKI_ROOT_PATH {
        return Ok(WIKI_ROOT_PATH.to_string());
    }
    Ok(trimmed.trim_end_matches('/').to_string())
}

fn path_under_prefix(path: &str, prefix: &str) -> bool {
    path == prefix
        || path
            .strip_prefix(prefix)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

fn parse_timestamp(value: &str) -> Result<DateTime<Utc>> {
    Ok(DateTime::parse_from_rfc3339(value)?.with_timezone(&Utc))
}

fn kinic_resource(database_id: &str, path: &str) -> String {
    format!("kinic://{database_id}{path}")
}

fn title_from_path(path: &str) -> String {
    path.rsplit('/')
        .next()
        .unwrap_or(path)
        .trim_end_matches(".md")
        .replace(['-', '_'], " ")
}

fn unique_slug(path: &str, used: &mut BTreeSet<String>) -> String {
    let mut slug = slug_for_path(path);
    if used.insert(slug.clone()) {
        return slug;
    }
    let base = slug;
    for index in 2.. {
        slug = format!("{base}-{index}");
        if used.insert(slug.clone()) {
            return slug;
        }
    }
    unreachable!()
}

fn slug_for_path(path: &str) -> String {
    let mut slug = String::new();
    let without_suffix = path.trim_start_matches('/').trim_end_matches(".md");
    let mut last_was_dash = false;
    for ch in without_suffix.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
            last_was_dash = false;
        } else if !last_was_dash {
            slug.push('-');
            last_was_dash = true;
        }
    }
    slug.trim_matches('-').to_string()
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut output = String::with_capacity(64);
    for byte in digest {
        output.push_str(&format!("{byte:02x}"));
    }
    format!("sha256:{output}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::Result;
    use async_trait::async_trait;
    use tempfile::tempdir;
    use vfs_types::{
        AppendNodeRequest, DeleteNodeRequest, DeleteNodeResult, EditNodeRequest, EditNodeResult,
        ExportSnapshotRequest, ExportSnapshotResponse, FetchUpdatesRequest, FetchUpdatesResponse,
        GlobNodeHit, GlobNodesRequest, ListChildrenRequest, MoveNodeRequest, MoveNodeResult,
        MultiEditNodeRequest, MultiEditNodeResult, SearchNodeHit, SearchNodePathsRequest,
        SearchNodesRequest, WriteNodeRequest, WriteNodeResult,
    };

    #[derive(Default)]
    struct MockClient {
        nodes: BTreeMap<String, Node>,
    }

    #[async_trait]
    impl VfsApi for MockClient {
        async fn status(&self, _database_id: &str) -> Result<vfs_types::Status> {
            unreachable!()
        }

        async fn read_node(&self, _database_id: &str, path: &str) -> Result<Option<Node>> {
            Ok(self.nodes.get(path).cloned())
        }

        async fn list_nodes(&self, request: ListNodesRequest) -> Result<Vec<vfs_types::NodeEntry>> {
            Ok(self
                .nodes
                .values()
                .filter(|node| path_under_prefix(&node.path, &request.prefix))
                .map(|node| vfs_types::NodeEntry {
                    path: node.path.clone(),
                    kind: match node.kind {
                        NodeKind::File => NodeEntryKind::File,
                        NodeKind::Source => NodeEntryKind::Source,
                        NodeKind::Folder => NodeEntryKind::Folder,
                    },
                    updated_at: node.updated_at,
                    etag: node.etag.clone(),
                    has_children: false,
                })
                .collect())
        }

        async fn list_children(
            &self,
            _request: ListChildrenRequest,
        ) -> Result<Vec<vfs_types::ChildNode>> {
            unreachable!()
        }

        async fn write_node(&self, _request: WriteNodeRequest) -> Result<WriteNodeResult> {
            unreachable!()
        }

        async fn append_node(&self, _request: AppendNodeRequest) -> Result<WriteNodeResult> {
            unreachable!()
        }

        async fn edit_node(&self, _request: EditNodeRequest) -> Result<EditNodeResult> {
            unreachable!()
        }

        async fn delete_node(&self, _request: DeleteNodeRequest) -> Result<DeleteNodeResult> {
            unreachable!()
        }

        async fn move_node(&self, _request: MoveNodeRequest) -> Result<MoveNodeResult> {
            unreachable!()
        }

        async fn mkdir_node(
            &self,
            _request: vfs_types::MkdirNodeRequest,
        ) -> Result<vfs_types::MkdirNodeResult> {
            unreachable!()
        }

        async fn glob_nodes(&self, _request: GlobNodesRequest) -> Result<Vec<GlobNodeHit>> {
            unreachable!()
        }

        async fn multi_edit_node(
            &self,
            _request: MultiEditNodeRequest,
        ) -> Result<MultiEditNodeResult> {
            unreachable!()
        }

        async fn search_nodes(&self, _request: SearchNodesRequest) -> Result<Vec<SearchNodeHit>> {
            unreachable!()
        }

        async fn search_node_paths(
            &self,
            _request: SearchNodePathsRequest,
        ) -> Result<Vec<SearchNodeHit>> {
            unreachable!()
        }

        async fn export_snapshot(
            &self,
            _request: ExportSnapshotRequest,
        ) -> Result<ExportSnapshotResponse> {
            unreachable!()
        }

        async fn fetch_updates(
            &self,
            _request: FetchUpdatesRequest,
        ) -> Result<FetchUpdatesResponse> {
            unreachable!()
        }
    }

    fn test_node(path: &str, kind: NodeKind, content: &str, etag: &str) -> Node {
        Node {
            path: path.to_string(),
            kind,
            content: content.to_string(),
            created_at: 1,
            updated_at: 2,
            etag: etag.to_string(),
            metadata_json: "{}".to_string(),
        }
    }

    #[tokio::test]
    async fn export_writes_okf_concepts_without_raw_source_text() {
        let out = tempdir().expect("tempdir");
        let mut client = MockClient::default();
        client.nodes.insert(
            "/Wiki/projects/acme/facts.md".to_string(),
            test_node(
                "/Wiki/projects/acme/facts.md",
                NodeKind::File,
                "Fact from /Sources/raw/web/source.md\n",
                "wiki-etag",
            ),
        );
        client.nodes.insert(
            "/Sources/raw/web/source.md".to_string(),
            test_node(
                "/Sources/raw/web/source.md",
                NodeKind::Source,
                "raw secret transcript",
                "source-etag",
            ),
        );

        let result = export_okf_bundle(
            &client,
            "alpha",
            ContextPackExportOptions {
                root: "/Wiki/projects/acme".to_string(),
                out: out.path().to_path_buf(),
                expires_at: "2999-01-01T00:00:00Z".to_string(),
                trust_level: "team-approved".to_string(),
                approved_by: vec!["principal:aaaaa-aa".to_string()],
                overwrite: false,
                json: true,
            },
        )
        .await
        .expect("export");

        assert_eq!(result.concept_count, 2);
        assert_eq!(result.reference_count, 1);
        let fact =
            fs::read_to_string(out.path().join("facts/wiki-projects-acme-facts.md")).expect("fact");
        assert!(fact.starts_with("---\n"));
        assert!(fact.contains("type: Fact"));
        assert!(fact.contains("Fact from /Sources/raw/web/source.md"));
        let reference = fs::read_to_string(out.path().join("references/sources-raw-web-source.md"))
            .expect("reference");
        assert!(reference.contains("type: Reference"));
        assert!(reference.contains("source-etag"));
        assert!(!reference.contains("raw secret transcript"));
        assert!(
            !fs::read_to_string(out.path().join(INDEX_FILE))
                .expect("index")
                .starts_with("---\n")
        );
        assert!(verify_okf_bundle_dir(out.path()).expect("verify").valid);

        let fact_path = out.path().join("facts/wiki-projects-acme-facts.md");
        let mut tampered = fs::read_to_string(&fact_path).expect("fact read");
        tampered.push_str("\nTampered line\n");
        fs::write(&fact_path, tampered).expect("tamper fact");
        let tampered_verify = verify_okf_bundle_dir(out.path()).expect("tampered verify");
        assert!(!tampered_verify.valid);
        assert!(
            tampered_verify
                .errors
                .iter()
                .any(|error| error.contains("kinic.content_hash mismatch"))
        );
    }

    #[tokio::test]
    async fn export_writes_unclassified_wiki_nodes_as_notes() {
        let out = tempdir().expect("tempdir");
        let mut client = MockClient::default();
        client.nodes.insert(
            "/Wiki/projects/acme/summary.md".to_string(),
            test_node(
                "/Wiki/projects/acme/summary.md",
                NodeKind::File,
                "Project summary",
                "summary-etag",
            ),
        );

        let result = export_okf_bundle(
            &client,
            "alpha",
            ContextPackExportOptions {
                root: "/Wiki/projects/acme".to_string(),
                out: out.path().to_path_buf(),
                expires_at: "2999-01-01T00:00:00Z".to_string(),
                trust_level: "draft".to_string(),
                approved_by: Vec::new(),
                overwrite: false,
                json: true,
            },
        )
        .await
        .expect("export");

        assert_eq!(result.concept_count, 1);
        assert_eq!(result.reference_count, 0);
        let note = fs::read_to_string(out.path().join("notes/wiki-projects-acme-summary.md"))
            .expect("note");
        assert!(note.contains("type: Note"));
        assert!(note.contains("Project summary"));

        let verify = verify_okf_bundle_dir(out.path()).expect("verify");
        assert!(verify.valid);
        assert_eq!(verify.reference_count, 0);
    }

    #[test]
    fn verify_rejects_missing_type() {
        let dir = tempdir().expect("tempdir");
        fs::write(
            dir.path().join("broken.md"),
            "---\ntitle: Broken\n---\n\n# Broken\n",
        )
        .expect("write");
        fs::write(dir.path().join(INDEX_FILE), "# Index\n").expect("index");
        fs::write(dir.path().join(LOG_FILE), "# Log\n").expect("log");

        let result = verify_okf_bundle_dir(dir.path()).expect("verify result");
        assert!(!result.valid);
        assert!(result.errors.iter().any(|error| error.contains("type")));
    }

    #[test]
    fn verify_rejects_expired_kinic_context() {
        let dir = tempdir().expect("tempdir");
        fs::write(
            dir.path().join("expired.md"),
            "---\ntype: Fact\nkinic:\n  expires_at: 2000-01-01T00:00:00Z\n---\n\n# Expired\n",
        )
        .expect("write");

        let result = verify_okf_bundle_dir(dir.path()).expect("verify result");
        assert!(!result.valid);
        assert!(
            result
                .errors
                .iter()
                .any(|error| error.contains("kinic.expires_at"))
        );
    }

    #[test]
    fn verify_rejects_reference_without_kinic_source_path() {
        let dir = tempdir().expect("tempdir");
        fs::create_dir_all(dir.path().join("references")).expect("refs");
        fs::write(
            dir.path().join("references/missing-kinic.md"),
            "---\ntype: Reference\n---\n\n# Reference\n",
        )
        .expect("write missing kinic");
        fs::write(
            dir.path().join("reference-no-source-path.md"),
            "---\ntype: Reference\nkinic:\n  database_id: alpha\n---\n\n# Reference\n",
        )
        .expect("write missing source path");

        let result = verify_okf_bundle_dir(dir.path()).expect("verify result");
        assert!(!result.valid);
        assert_eq!(result.reference_count, 2);
        assert!(
            result
                .errors
                .iter()
                .any(|error| error.contains("missing-kinic.md")
                    && error.contains("kinic.source_path"))
        );
        assert!(
            result
                .errors
                .iter()
                .any(|error| error.contains("reference-no-source-path.md")
                    && error.contains("kinic.source_path"))
        );
    }

    #[test]
    fn inspect_reports_counts_and_kinic_summary() {
        let dir = tempdir().expect("tempdir");
        fs::create_dir_all(dir.path().join("references")).expect("refs");
        fs::write(
            dir.path().join("references/source.md"),
            "---\ntype: Reference\nkinic:\n  database_id: alpha\n  root: /Wiki/projects/acme\n  source_path: /Sources/raw/web/source.md\n  expires_at: 2999-01-01T00:00:00Z\n---\n\n# Reference\n",
        )
        .expect("write");

        let result = inspect_okf_bundle_dir(dir.path()).expect("inspect");
        assert_eq!(result.concept_count, 1);
        assert_eq!(result.reference_count, 1);
        assert_eq!(result.types.get("Reference"), Some(&1));
        assert_eq!(result.kinic.database_ids, vec!["alpha"]);
        assert_eq!(result.kinic.roots, vec!["/Wiki/projects/acme"]);
    }

    #[test]
    fn source_path_extraction_stops_at_markdown_delimiters() {
        let paths = extract_raw_source_paths(
            "See [/Sources/raw/web/source.md](/Sources/raw/web/source.md), then `/Sources/raw/a/b.md`.",
        );
        assert_eq!(
            paths,
            vec![
                "/Sources/raw/web/source.md",
                "/Sources/raw/web/source.md",
                "/Sources/raw/a/b.md"
            ]
        );
    }
}
