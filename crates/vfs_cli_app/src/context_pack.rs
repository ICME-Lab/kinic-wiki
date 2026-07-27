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
use vfs_types::{LinkEdge, Node, NodeKind, QueryContext, QueryContextRequest, SourceEvidenceRef};
use wiki_domain::{
    KNOWLEDGE_SOURCES_PREFIX, SESSION_SOURCES_PREFIX, SKILL_REGISTRY_ROOT, SKILL_RUNS_PREFIX,
    WIKI_ROOT_PATH, extract_frontmatter_block, validate_canonical_source_path,
    validate_knowledge_source_path,
};

const OKF_VERSION: &str = "0.1";
const INDEX_FILE: &str = "index.md";
const LOG_FILE: &str = "log.md";
const OKF_MANIFEST_FILE: &str = "okf.yaml";
const OKF_OWNED_DIRS: &[&str] = &[
    "facts",
    "decisions",
    "tasks",
    "policies",
    "notes",
    "references",
];
const LEGACY_TOP_LEVEL_JSON: &[&str] = &["manifest.json", "sources.json", "provenance.json"];
const DATABASE_ROOT_PATH: &str = "/";
const MEMORY_ROOT_PATH: &str = "/Memory";
const SESSION_ROOT_PATH: &str = "/Sessions";
const CONTEXT_PACK_NAMESPACE_ROOTS: &[&str] = &[
    WIKI_ROOT_PATH,
    MEMORY_ROOT_PATH,
    SKILL_REGISTRY_ROOT,
    SESSION_ROOT_PATH,
    KNOWLEDGE_SOURCES_PREFIX,
];

#[derive(Debug, Clone)]
pub struct ContextPackExportOptions {
    pub task: String,
    pub namespace: String,
    pub budget_tokens: u32,
    pub depth: u32,
    pub entities: Vec<String>,
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
    pub fail_on_truncated: bool,
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
    pub truncated: bool,
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
    pub task: String,
    pub namespace: String,
    pub budget_tokens: u32,
    pub depth: u32,
    pub truncated: bool,
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
    store: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    store_path: Option<String>,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct OkfBundleManifest {
    okf_version: String,
    generated_at: String,
    task: String,
    namespace: String,
    budget_tokens: u32,
    depth: u32,
    truncated: bool,
    concept_count: usize,
    reference_count: usize,
    selected_nodes: Vec<OkfSelectedNode>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct OkfSelectedNode {
    path: String,
    #[serde(rename = "type")]
    concept_type: String,
    etag: String,
    content_hash: String,
    output_path: String,
}

#[derive(Debug, Clone, Copy)]
struct OkfBuildMetadata<'a> {
    database_id: &'a str,
    namespace: &'a str,
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

#[derive(Debug, Clone)]
struct OkfBundleContext<'a> {
    namespace: &'a str,
    task: &'a str,
    budget_tokens: u32,
    depth: u32,
    truncated: bool,
}

#[derive(Debug, Clone)]
struct OkfReference {
    store: String,
    store_path: String,
    via_path: String,
    target_href: String,
    link_text: String,
    etag: Option<String>,
    updated_at: Option<i64>,
    content_hash: Option<String>,
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
    let result = verify_okf_bundle_dir(&options.path, options.fail_on_truncated)?;
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
        println!("task: {}", result.task);
        println!("namespace: {}", result.namespace);
        println!("budget_tokens: {}", result.budget_tokens);
        println!("depth: {}", result.depth);
        println!("truncated: {}", result.truncated);
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
    let namespace = normalize_wiki_namespace(&options.namespace)?;
    parse_timestamp(&options.expires_at).context("expires_at must be RFC3339")?;
    ensure_output_dir(&options.out, options.overwrite)?;

    let generated_at = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
    let context = client
        .query_context(QueryContextRequest {
            database_id: database_id.to_string(),
            task: options.task.clone(),
            entities: options.entities.clone(),
            namespace: Some(namespace.clone()),
            budget_tokens: options.budget_tokens,
            include_evidence: true,
            depth: options.depth,
        })
        .await?;
    let wiki_nodes = collect_context_nodes(&context);
    let references = collect_context_references(client, database_id, &context).await?;
    let metadata = OkfBuildMetadata {
        database_id,
        namespace: &namespace,
        generated_at: &generated_at,
        expires_at: &options.expires_at,
        trust_level: &options.trust_level,
        approved_by: &options.approved_by,
    };
    let bundle_context = OkfBundleContext {
        namespace: &namespace,
        task: &options.task,
        budget_tokens: options.budget_tokens,
        depth: options.depth,
        truncated: context.truncated,
    };
    let concepts = build_okf_concepts(metadata, &wiki_nodes, &references)?;

    write_okf_bundle(&options.out, bundle_context, &generated_at, &concepts)?;

    Ok(OkfExportResult {
        out: options.out.display().to_string(),
        okf_version: OKF_VERSION.to_string(),
        concept_count: concepts.len(),
        reference_count: references.len(),
        truncated: context.truncated,
    })
}

pub fn verify_okf_bundle_dir(path: &Path, fail_on_truncated: bool) -> Result<OkfVerifyResult> {
    let mut errors = Vec::new();
    let mut concept_count = 0;
    let mut reference_count = 0;
    for reserved in [INDEX_FILE, LOG_FILE, OKF_MANIFEST_FILE] {
        let reserved_path = path.join(reserved);
        if !reserved_path.is_file() {
            errors.push(format!("missing required reserved file: {reserved}"));
        }
    }
    let manifest = match read_okf_manifest(path) {
        Ok(manifest) => {
            if manifest.okf_version != OKF_VERSION {
                errors.push(format!(
                    "okf.yaml: okf_version mismatch: expected {OKF_VERSION}, got {}",
                    manifest.okf_version
                ));
            }
            if fail_on_truncated && manifest.truncated {
                errors.push("okf.yaml: truncated context is not allowed".to_string());
            }
            Some(manifest)
        }
        Err(error) => {
            errors.push(format!("okf.yaml: {error}"));
            None
        }
    };
    let mut actual_selected_nodes = BTreeMap::<String, OkfSelectedNode>::new();
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
        let is_reference_type = frontmatter.concept_type == "Reference";
        let is_under_references = path_under_top_level_dir(relative, "references");
        let is_verified_reference_shape = is_reference_type && is_under_references;
        if is_reference_type {
            reference_count += 1;
        }
        if frontmatter.concept_type.trim().is_empty() {
            errors.push(format!("{}: type is required", relative.display()));
        }
        if is_under_references && !is_reference_type {
            errors.push(format!(
                "{}: references files must use type: Reference",
                relative.display()
            ));
        }
        if is_reference_type && !is_under_references {
            errors.push(format!(
                "{}: type: Reference must be under references/",
                relative.display()
            ));
        }
        if let Some(kinic) = &frontmatter.kinic {
            if let Some(manifest) = &manifest {
                match &kinic.root {
                    Some(root) if root == &manifest.namespace => {}
                    Some(root) => errors.push(format!(
                        "{}: kinic.root does not match okf.yaml namespace: {root}",
                        relative.display()
                    )),
                    None => errors.push(format!("{}: kinic.root is required", relative.display())),
                }
            }
            if !is_verified_reference_shape && is_kinic_wiki_concept(&frontmatter) {
                match &kinic.content_hash {
                    Some(expected_hash) => match okf_body_text(&file) {
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
                    },
                    None => errors.push(format!(
                        "{}: kinic.content_hash is required",
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
            if is_reference_type {
                match validate_reference_store_metadata(kinic) {
                    Ok(()) => {}
                    Err(error) => errors.push(format!("{}: {error}", relative.display())),
                }
                if kinic.etag.as_deref().unwrap_or("").is_empty() {
                    errors.push(format!(
                        "{}: reference concept requires kinic.etag",
                        relative.display()
                    ));
                }
                if kinic.content_hash.as_deref().unwrap_or("").is_empty() {
                    errors.push(format!(
                        "{}: reference concept requires kinic.content_hash",
                        relative.display()
                    ));
                }
                if let Err(error) = verify_reference_body(&file, kinic) {
                    errors.push(format!("{}: {error}", relative.display()));
                }
            }
            match selected_node_from_frontmatter(relative, &frontmatter, &file) {
                Ok(selected) => {
                    actual_selected_nodes.insert(selected.output_path.clone(), selected);
                }
                Err(error) => errors.push(format!(
                    "{}: failed to build selected node metadata: {error}",
                    relative.display()
                )),
            }
        } else {
            if is_kinic_wiki_concept(&frontmatter) {
                errors.push(format!(
                    "{}: kinic.content_hash is required",
                    relative.display()
                ));
            }
            if is_reference_type {
                errors.push(format!(
                    "{}: reference concept requires kinic.store and kinic.store_path",
                    relative.display()
                ));
            }
        }
    }
    if let Some(manifest) = &manifest {
        if manifest.concept_count != concept_count {
            errors.push(format!(
                "okf.yaml: concept_count mismatch: expected {}, actual {concept_count}",
                manifest.concept_count
            ));
        }
        if manifest.reference_count != reference_count {
            errors.push(format!(
                "okf.yaml: reference_count mismatch: expected {}, actual {reference_count}",
                manifest.reference_count
            ));
        }
        verify_selected_nodes(manifest, &actual_selected_nodes, &mut errors);
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
    let manifest = read_okf_manifest(path)?;
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
        okf_version: manifest.okf_version,
        task: manifest.task,
        namespace: manifest.namespace,
        budget_tokens: manifest.budget_tokens,
        depth: manifest.depth,
        truncated: manifest.truncated,
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

fn collect_context_nodes(context: &QueryContext) -> Vec<BucketedNode> {
    context
        .nodes
        .iter()
        .filter(|context| context.node.kind == NodeKind::File)
        .map(|context| BucketedNode {
            bucket: bucket_for_path(&context.node.path),
            node: context.node.clone(),
        })
        .collect()
}

async fn collect_context_references(
    client: &impl VfsApi,
    database_id: &str,
    context: &QueryContext,
) -> Result<Vec<OkfReference>> {
    let mut references = BTreeMap::<String, OkfReference>::new();
    for evidence in &context.evidence {
        for item in &evidence.refs {
            if !exportable_reference_path(&item.source_path) {
                continue;
            }
            references
                .entry(item.source_path.clone())
                .or_insert_with(|| okf_reference_from_evidence(item));
        }
    }
    for node in &context.nodes {
        for edge in &node.outgoing_links {
            if !exportable_reference_path(&edge.target_path) {
                continue;
            }
            if references.contains_key(&edge.target_path) {
                continue;
            }
            let reference = okf_reference_from_link(client, database_id, edge).await?;
            references.insert(edge.target_path.clone(), reference);
        }
    }
    Ok(references.into_values().collect())
}

fn okf_reference_from_evidence(item: &SourceEvidenceRef) -> OkfReference {
    let store = reference_store_for_path(&item.source_path)
        .expect("caller checked supported reference store")
        .to_string();
    OkfReference {
        store,
        store_path: item.source_path.clone(),
        via_path: item.via_path.clone(),
        target_href: item.raw_href.clone(),
        link_text: item.link_text.clone(),
        etag: item.source_etag.clone(),
        updated_at: item.source_updated_at,
        content_hash: item.source_content_hash.clone(),
    }
}

async fn okf_reference_from_link(
    client: &impl VfsApi,
    database_id: &str,
    edge: &LinkEdge,
) -> Result<OkfReference> {
    let store = reference_store_for_path(&edge.target_path)
        .ok_or_else(|| anyhow!("unsupported reference target: {}", edge.target_path))?
        .to_string();
    let target = client
        .read_node(database_id, &edge.target_path)
        .await?
        .ok_or_else(|| anyhow!("reference target not found: {}", edge.target_path))?;
    Ok(OkfReference {
        store,
        store_path: edge.target_path.clone(),
        via_path: edge.source_path.clone(),
        target_href: edge.raw_href.clone(),
        link_text: edge.link_text.clone(),
        etag: Some(target.etag),
        updated_at: Some(target.updated_at),
        content_hash: Some(sha256_hex(target.content.as_bytes())),
    })
}

fn build_okf_concepts(
    metadata: OkfBuildMetadata<'_>,
    wiki_nodes: &[BucketedNode],
    references: &[OkfReference],
) -> Result<Vec<OkfConcept>> {
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
                    root: Some(metadata.namespace.to_string()),
                    store: None,
                    store_path: None,
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

    for reference in references {
        if reference.etag.as_deref().unwrap_or("").is_empty() {
            bail!("store reference is missing etag: {}", reference.store_path);
        }
        if reference.content_hash.as_deref().unwrap_or("").is_empty() {
            bail!(
                "store reference is missing content_hash: {}",
                reference.store_path
            );
        }
        let slug = unique_slug(&reference.store_path, &mut used_paths);
        let relative_path = PathBuf::from("references").join(format!("{slug}.md"));
        concepts.push(OkfConcept {
            relative_path,
            frontmatter: OkfFrontmatter {
                concept_type: "Reference".to_string(),
                title: Some(title_from_path(&reference.store_path)),
                description: Some(format!(
                    "Kinic {} reference for {}",
                    reference.store, reference.store_path
                )),
                resource: Some(kinic_resource(metadata.database_id, &reference.store_path)),
                tags: vec!["kinic".to_string(), "reference".to_string()],
                timestamp: Some(metadata.generated_at.to_string()),
                kinic: Some(KinicFrontmatter {
                    database_id: Some(metadata.database_id.to_string()),
                    root: Some(metadata.namespace.to_string()),
                    store: Some(reference.store.clone()),
                    store_path: Some(reference.store_path.clone()),
                    etag: reference.etag.clone(),
                    content_hash: reference.content_hash.clone(),
                    trust_level: Some(metadata.trust_level.to_string()),
                    approved_by: metadata.approved_by.to_vec(),
                    expires_at: Some(metadata.expires_at.to_string()),
                }),
            },
            body: reference_body(reference),
        });
    }

    concepts.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    Ok(concepts)
}

fn write_okf_bundle(
    out: &Path,
    context: OkfBundleContext<'_>,
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
    fs::write(
        out.join(INDEX_FILE),
        render_index(context.clone(), concepts),
    )?;
    fs::write(
        out.join(LOG_FILE),
        render_log(context.clone(), generated_at, concepts),
    )?;
    fs::write(
        out.join(OKF_MANIFEST_FILE),
        serde_yaml::to_string(&build_okf_manifest(context, generated_at, concepts)?)?,
    )?;
    Ok(())
}

fn build_okf_manifest(
    context: OkfBundleContext<'_>,
    generated_at: &str,
    concepts: &[OkfConcept],
) -> Result<OkfBundleManifest> {
    let selected_nodes = concepts
        .iter()
        .map(selected_node_from_concept)
        .collect::<Result<Vec<_>>>()?;
    let reference_count = concepts
        .iter()
        .filter(|concept| concept.frontmatter.concept_type == "Reference")
        .count();
    Ok(OkfBundleManifest {
        okf_version: OKF_VERSION.to_string(),
        generated_at: generated_at.to_string(),
        task: context.task.to_string(),
        namespace: context.namespace.to_string(),
        budget_tokens: context.budget_tokens,
        depth: context.depth,
        truncated: context.truncated,
        concept_count: concepts.len(),
        reference_count,
        selected_nodes,
    })
}

fn selected_node_from_concept(concept: &OkfConcept) -> Result<OkfSelectedNode> {
    let kinic = concept
        .frontmatter
        .kinic
        .as_ref()
        .ok_or_else(|| anyhow!("concept is missing kinic metadata"))?;
    let path = context_path_from_frontmatter(&concept.frontmatter)?;
    Ok(OkfSelectedNode {
        path,
        concept_type: concept.frontmatter.concept_type.clone(),
        etag: kinic.etag.clone().unwrap_or_default(),
        content_hash: kinic.content_hash.clone().unwrap_or_default(),
        output_path: concept.relative_path.to_string_lossy().to_string(),
    })
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

fn render_index(context: OkfBundleContext<'_>, concepts: &[OkfConcept]) -> String {
    let mut groups = BTreeMap::<String, Vec<&OkfConcept>>::new();
    for concept in concepts {
        groups
            .entry(concept.frontmatter.concept_type.clone())
            .or_default()
            .push(concept);
    }
    let reference_count = concepts
        .iter()
        .filter(|concept| concept.frontmatter.concept_type == "Reference")
        .count();
    let mut output = format!(
        "# OKF Context Bundle\n\n- task: `{}`\n- namespace: `{}`\n- budget_tokens: `{}`\n- depth: `{}`\n- truncated: `{}`\n- concept_count: `{}`\n- reference_count: `{}`\n",
        escape_inline_code(context.task),
        escape_inline_code(context.namespace),
        context.budget_tokens,
        context.depth,
        context.truncated,
        concepts.len(),
        reference_count
    );
    if concepts.is_empty() {
        output.push_str("\nNo context nodes matched this task.\n");
        return output;
    }
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

fn render_log(
    context: OkfBundleContext<'_>,
    generated_at: &str,
    concepts: &[OkfConcept],
) -> String {
    let date = generated_at.split('T').next().unwrap_or(generated_at);
    let reference_count = concepts
        .iter()
        .filter(|concept| concept.frontmatter.concept_type == "Reference")
        .count();
    format!(
        "# Directory Update Log\n\n## {date}\n\n* **Export**: Generated task-scoped OKF context bundle for `{}` in `{}` ({} concepts, {} references, truncated: {}).\n",
        escape_inline_code(context.task),
        escape_inline_code(context.namespace),
        concepts.len(),
        reference_count,
        context.truncated
    )
}

fn reference_body(reference: &OkfReference) -> String {
    format!(
        "# Reference\n\n- store: `{}`\n- store_path: `{}`\n- via_path: `{}`\n- target_href: `{}`\n- link_text: `{}`\n- etag: `{}`\n- updated_at: `{}`\n- content_hash: `{}`\n\nReferenced store content is not copied into this OKF bundle.\n",
        escape_inline_code(&reference.store),
        escape_inline_code(&reference.store_path),
        escape_inline_code(&reference.via_path),
        escape_inline_code(&reference.target_href),
        escape_inline_code(&reference.link_text),
        escape_inline_code(reference.etag.as_deref().unwrap_or("")),
        reference
            .updated_at
            .map(|value| value.to_string())
            .unwrap_or_default(),
        escape_inline_code(reference.content_hash.as_deref().unwrap_or(""))
    )
}

fn escape_inline_code(value: &str) -> String {
    value.replace('`', "\\`")
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

fn read_okf_manifest(path: &Path) -> Result<OkfBundleManifest> {
    let manifest_path = path.join(OKF_MANIFEST_FILE);
    let text = fs::read_to_string(&manifest_path)
        .with_context(|| format!("failed to read {}", manifest_path.display()))?;
    Ok(serde_yaml::from_str(&text)?)
}

fn okf_body_text(path: &Path) -> Result<String> {
    let text = fs::read_to_string(path)?;
    let frontmatter = extract_frontmatter_block(&text)
        .ok_or_else(|| anyhow!("missing YAML frontmatter delimited by ---"))?;
    let body_start = "---\n".len() + frontmatter.len() + "\n---".len();
    let body = text[body_start..].trim_start_matches('\n');
    Ok(body.trim_end_matches('\n').to_string())
}

fn selected_node_from_frontmatter(
    relative: &Path,
    frontmatter: &OkfFrontmatter,
    file: &Path,
) -> Result<OkfSelectedNode> {
    let kinic = frontmatter
        .kinic
        .as_ref()
        .ok_or_else(|| anyhow!("kinic metadata is required"))?;
    let path = context_path_from_frontmatter(frontmatter)?;
    let content_hash = if frontmatter.concept_type == "Reference" {
        kinic.content_hash.clone().unwrap_or_default()
    } else {
        sha256_hex(okf_body_text(file)?.as_bytes())
    };
    Ok(OkfSelectedNode {
        path,
        concept_type: frontmatter.concept_type.clone(),
        etag: kinic.etag.clone().unwrap_or_default(),
        content_hash,
        output_path: relative.to_string_lossy().to_string(),
    })
}

fn context_path_from_frontmatter(frontmatter: &OkfFrontmatter) -> Result<String> {
    if frontmatter.concept_type == "Reference" {
        let store_path = frontmatter
            .kinic
            .as_ref()
            .and_then(|kinic| kinic.store_path.clone())
            .ok_or_else(|| anyhow!("reference store_path is required"))?;
        return Ok(store_path);
    }
    let resource = frontmatter
        .resource
        .as_ref()
        .ok_or_else(|| anyhow!("resource is required"))?;
    let Some(rest) = resource.strip_prefix("kinic://") else {
        return Ok(resource.to_string());
    };
    let Some(path_start) = rest.find('/') else {
        return Ok(resource.to_string());
    };
    Ok(rest[path_start..].to_string())
}

fn verify_selected_nodes(
    manifest: &OkfBundleManifest,
    actual: &BTreeMap<String, OkfSelectedNode>,
    errors: &mut Vec<String>,
) {
    let mut expected = BTreeMap::<String, OkfSelectedNode>::new();
    for node in &manifest.selected_nodes {
        if expected
            .insert(node.output_path.clone(), node.clone())
            .is_some()
        {
            errors.push(format!(
                "okf.yaml: duplicate selected_nodes output_path: {}",
                node.output_path
            ));
        }
    }
    for (output_path, expected_node) in &expected {
        match actual.get(output_path) {
            Some(actual_node) if actual_node == expected_node => {}
            Some(actual_node) => errors.push(format!(
                "okf.yaml: selected_nodes mismatch for {output_path}: expected {:?}, actual {:?}",
                expected_node, actual_node
            )),
            None => errors.push(format!(
                "okf.yaml: selected_nodes references missing output_path: {output_path}"
            )),
        }
    }
    for output_path in actual.keys() {
        if !expected.contains_key(output_path) {
            errors.push(format!(
                "okf.yaml: selected_nodes is missing concept output_path: {output_path}"
            ));
        }
    }
}

fn verify_reference_body(path: &Path, kinic: &KinicFrontmatter) -> Result<()> {
    let body = okf_body_text(path)?;
    let lines = body.lines().collect::<Vec<_>>();
    if lines.len() != 12
        || lines[0] != "# Reference"
        || !lines[1].is_empty()
        || !lines[10].is_empty()
        || lines[11] != "Referenced store content is not copied into this OKF bundle."
    {
        bail!("reference body must use the fixed metadata-only shape");
    }
    let store = inline_code_value(lines[2], "- store: `")?;
    let store_path = inline_code_value(lines[3], "- store_path: `")?;
    let _via_path = inline_code_value(lines[4], "- via_path: `")?;
    let _target_href = inline_code_value(lines[5], "- target_href: `")?;
    let _link_text = inline_code_value(lines[6], "- link_text: `")?;
    let etag = inline_code_value(lines[7], "- etag: `")?;
    let _updated_at = inline_code_value(lines[8], "- updated_at: `")?;
    let content_hash = inline_code_value(lines[9], "- content_hash: `")?;
    if Some(store.as_str()) != kinic.store.as_deref() {
        bail!("reference body store does not match frontmatter");
    }
    if Some(store_path.as_str()) != kinic.store_path.as_deref() {
        bail!("reference body store_path does not match frontmatter");
    }
    if Some(etag.as_str()) != kinic.etag.as_deref() {
        bail!("reference body etag does not match frontmatter");
    }
    if Some(content_hash.as_str()) != kinic.content_hash.as_deref() {
        bail!("reference body content_hash does not match frontmatter");
    }
    Ok(())
}

fn inline_code_value(line: &str, prefix: &str) -> Result<String> {
    let value = line
        .strip_prefix(prefix)
        .and_then(|rest| rest.strip_suffix('`'))
        .ok_or_else(|| anyhow!("reference body must use fixed metadata bullets"))?;
    Ok(value.replace("\\`", "`"))
}

fn frontmatter_text(text: &str) -> Option<&str> {
    extract_frontmatter_block(text)
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

fn path_under_top_level_dir(path: &Path, expected: &str) -> bool {
    path.components()
        .next()
        .is_some_and(|component| component.as_os_str() == std::ffi::OsStr::new(expected))
}

fn is_kinic_wiki_concept(frontmatter: &OkfFrontmatter) -> bool {
    let has_kinic_wiki_resource = frontmatter
        .resource
        .as_deref()
        .is_some_and(resource_points_to_wiki);
    let has_kinic_metadata = frontmatter.kinic.as_ref().is_some_and(|kinic| {
        kinic.database_id.is_some()
            || kinic
                .root
                .as_deref()
                .is_some_and(|root| path_under_prefix(root, WIKI_ROOT_PATH))
    });
    has_kinic_wiki_resource || has_kinic_metadata
}

fn resource_points_to_wiki(resource: &str) -> bool {
    let Some((scheme, rest)) = resource.split_once("://") else {
        return false;
    };
    if scheme != "kinic" {
        return false;
    }
    let Some(path_start) = rest.find('/') else {
        return false;
    };
    path_under_prefix(&rest[path_start..], WIKI_ROOT_PATH)
}

fn ensure_output_dir(out: &Path, overwrite: bool) -> Result<()> {
    if out.exists() && !out.is_dir() {
        bail!("OKF output path is not a directory: {}", out.display());
    }
    fs::create_dir_all(out)?;
    if overwrite {
        remove_owned_bundle_paths(out)?;
    } else {
        let existing = collect_markdown_files(out)?;
        if !existing.is_empty() || out.join(OKF_MANIFEST_FILE).exists() {
            bail!(
                "OKF markdown files already exist in {}; pass --overwrite to replace them",
                out.display()
            );
        }
    }
    Ok(())
}

fn remove_owned_bundle_paths(out: &Path) -> Result<()> {
    for file_name in [INDEX_FILE, LOG_FILE, OKF_MANIFEST_FILE] {
        remove_path_if_exists(&out.join(file_name))?;
    }
    for dir_name in OKF_OWNED_DIRS {
        remove_path_if_exists(&out.join(dir_name))?;
    }
    for legacy_name in LEGACY_TOP_LEVEL_JSON {
        remove_path_if_exists(&out.join(legacy_name))?;
    }
    Ok(())
}

fn remove_path_if_exists(path: &Path) -> Result<()> {
    if !path.exists() {
        return Ok(());
    }
    if path.is_dir() {
        fs::remove_dir_all(path)?;
    } else {
        fs::remove_file(path)?;
    }
    Ok(())
}

fn normalize_wiki_namespace(namespace: &str) -> Result<String> {
    let trimmed = namespace.trim();
    if trimmed == DATABASE_ROOT_PATH {
        return Ok(DATABASE_ROOT_PATH.to_string());
    }
    for root in CONTEXT_PACK_NAMESPACE_ROOTS {
        if path_under_prefix(trimmed, root) {
            return if trimmed == *root {
                Ok((*root).to_string())
            } else {
                Ok(trimmed.trim_end_matches('/').to_string())
            };
        }
    }
    bail!("context pack namespace must be / or stay under a known database root: {namespace}");
}

fn path_under_prefix(path: &str, prefix: &str) -> bool {
    path == prefix
        || path
            .strip_prefix(prefix)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

fn validate_reference_store_metadata(kinic: &KinicFrontmatter) -> Result<()> {
    let store = kinic
        .store
        .as_deref()
        .ok_or_else(|| anyhow!("reference concept requires kinic.store"))?;
    let store_path = kinic
        .store_path
        .as_deref()
        .ok_or_else(|| anyhow!("reference concept requires kinic.store_path"))?;
    let expected_store = reference_store_for_path(store_path).ok_or_else(|| {
        anyhow!("kinic.store_path is outside supported store roots: {store_path}")
    })?;
    if store != expected_store {
        bail!(
            "kinic.store does not match kinic.store_path: expected {expected_store}, got {store}"
        );
    }
    Ok(())
}

fn reference_store_for_path(path: &str) -> Option<&'static str> {
    if path_under_prefix(path, SKILL_RUNS_PREFIX) && validate_canonical_source_path(path).is_ok() {
        Some("skill_run_evidence")
    } else if path_under_prefix(path, SESSION_SOURCES_PREFIX)
        && validate_canonical_source_path(path).is_ok()
    {
        Some("session_evidence")
    } else if validate_knowledge_source_path(path).is_ok() {
        Some("source_evidence")
    } else if path_under_prefix(path, SESSION_ROOT_PATH) {
        Some("session")
    } else if path_under_prefix(path, SKILL_REGISTRY_ROOT) {
        Some("skill")
    } else if path_under_prefix(path, WIKI_ROOT_PATH) {
        Some("knowledge")
    } else if path_under_prefix(path, MEMORY_ROOT_PATH) {
        Some("memory")
    } else {
        None
    }
}

fn exportable_reference_path(path: &str) -> bool {
    validate_knowledge_source_path(path).is_ok()
        || (path_under_prefix(path, SESSION_SOURCES_PREFIX)
            && validate_canonical_source_path(path).is_ok())
        || (path_under_prefix(path, SKILL_RUNS_PREFIX)
            && validate_canonical_source_path(path).is_ok())
        || path_under_prefix(path, SESSION_ROOT_PATH)
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
mod tests;
