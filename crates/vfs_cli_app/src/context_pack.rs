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
use vfs_types::{
    KnowledgeEvidenceRef, LinkEdge, MemoryRecall, MemoryRecallRequest, Node, NodeKind,
};
use wiki_domain::{
    SESSION_SOURCES_PREFIX, SKILL_REGISTRY_ROOT, SKILL_RUNS_PREFIX, WIKI_ROOT_PATH,
    validate_canonical_source_path, validate_knowledge_source_path,
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
const MEMORY_ROOT_PATH: &str = "/Memory";
const SESSION_ROOT_PATH: &str = "/Sessions";

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
        .memory_recall(MemoryRecallRequest {
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

fn collect_context_nodes(context: &MemoryRecall) -> Vec<BucketedNode> {
    context
        .nodes
        .iter()
        .filter(|context| matches!(context.node.kind, NodeKind::File | NodeKind::Source))
        .map(|context| BucketedNode {
            bucket: bucket_for_path(&context.node.path),
            node: context.node.clone(),
        })
        .collect()
}

async fn collect_context_references(
    client: &impl VfsApi,
    database_id: &str,
    context: &MemoryRecall,
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

fn okf_reference_from_evidence(item: &KnowledgeEvidenceRef) -> OkfReference {
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
    if !path_under_prefix(trimmed, WIKI_ROOT_PATH) {
        bail!("context pack namespace must stay under {WIKI_ROOT_PATH}: {namespace}");
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
        Some("knowledge_evidence")
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
mod tests {
    use super::*;
    use anyhow::Result;
    use async_trait::async_trait;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tempfile::tempdir;
    use vfs_types::{
        AppendNodeRequest, DeleteNodeRequest, DeleteNodeResult, EditNodeRequest, EditNodeResult,
        ExportSnapshotRequest, ExportSnapshotResponse, FetchUpdatesRequest, FetchUpdatesResponse,
        GlobNodeHit, GlobNodesRequest, KnowledgeEvidence, KnowledgeEvidenceRef,
        ListChildrenRequest, MemoryRecall, MemoryRecallRequest, MoveNodeRequest, MoveNodeResult,
        MultiEditNodeRequest, MultiEditNodeResult, NodeContext, SearchNodeHit,
        SearchNodePathsRequest, SearchNodesRequest, WriteNodeRequest, WriteNodeResult,
    };

    struct MockClient {
        context: MemoryRecall,
        readable_nodes: BTreeMap<String, Node>,
        read_node_calls: AtomicUsize,
        list_nodes_calls: AtomicUsize,
    }

    impl Default for MockClient {
        fn default() -> Self {
            Self {
                context: MemoryRecall {
                    namespace: WIKI_ROOT_PATH.to_string(),
                    task: String::new(),
                    search_hits: Vec::new(),
                    nodes: Vec::new(),
                    graph_links: Vec::new(),
                    evidence: Vec::new(),
                    truncated: false,
                },
                readable_nodes: BTreeMap::new(),
                read_node_calls: AtomicUsize::new(0),
                list_nodes_calls: AtomicUsize::new(0),
            }
        }
    }

    #[async_trait]
    impl VfsApi for MockClient {
        async fn status(&self, _database_id: &str) -> Result<vfs_types::Status> {
            unreachable!()
        }

        async fn read_node(&self, _database_id: &str, path: &str) -> Result<Option<Node>> {
            self.read_node_calls.fetch_add(1, Ordering::SeqCst);
            if let Some(node) = self.readable_nodes.get(path) {
                return Ok(Some(node.clone()));
            }
            bail!("unexpected read_node during context-pack export: {path}")
        }

        async fn list_nodes(
            &self,
            _request: vfs_types::ListNodesRequest,
        ) -> Result<Vec<vfs_types::NodeEntry>> {
            self.list_nodes_calls.fetch_add(1, Ordering::SeqCst);
            bail!("list_nodes must not be called during context-pack export")
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

        async fn memory_recall(&self, request: MemoryRecallRequest) -> Result<MemoryRecall> {
            assert!(request.include_evidence);
            Ok(MemoryRecall {
                namespace: request
                    .namespace
                    .unwrap_or_else(|| WIKI_ROOT_PATH.to_string()),
                task: request.task,
                ..self.context.clone()
            })
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

    fn test_node_context(path: &str, content: &str, etag: &str) -> NodeContext {
        NodeContext {
            node: test_node(path, NodeKind::File, content, etag),
            incoming_links: Vec::new(),
            outgoing_links: Vec::new(),
        }
    }

    fn test_source_evidence(
        node_path: &str,
        source_path: &str,
        source_content_hash: &str,
    ) -> KnowledgeEvidence {
        KnowledgeEvidence {
            node_path: node_path.to_string(),
            refs: vec![KnowledgeEvidenceRef {
                source_path: source_path.to_string(),
                via_path: node_path.to_string(),
                raw_href: source_path.to_string(),
                link_text: "Raw".to_string(),
                source_etag: Some("source-etag".to_string()),
                source_updated_at: Some(3),
                source_content_hash: Some(source_content_hash.to_string()),
            }],
        }
    }

    async fn export_reference_bundle(out: &Path, truncated: bool) {
        let mut client = MockClient::default();
        client.context.nodes = vec![test_node_context(
            "/Wiki/projects/acme/facts.md",
            "Fact from /Sources/web/source.md\n",
            "wiki-etag",
        )];
        client.context.evidence = vec![test_source_evidence(
            "/Wiki/projects/acme/facts.md",
            "/Sources/web/source.md",
            "sha256:sourcehash",
        )];
        client.context.truncated = truncated;
        export_okf_bundle(
            &client,
            "alpha",
            ContextPackExportOptions {
                task: "acme facts".to_string(),
                namespace: "/Wiki/projects/acme".to_string(),
                budget_tokens: 8_000,
                depth: 1,
                entities: vec!["acme".to_string()],
                out: out.to_path_buf(),
                expires_at: "2999-01-01T00:00:00Z".to_string(),
                trust_level: "team-approved".to_string(),
                approved_by: vec!["principal:aaaaa-aa".to_string()],
                overwrite: false,
                json: true,
            },
        )
        .await
        .expect("export");
    }

    fn write_reserved_files(dir: &Path) {
        fs::write(dir.join(INDEX_FILE), "# Index\n").expect("index");
        fs::write(dir.join(LOG_FILE), "# Log\n").expect("log");
        fs::write(
            dir.join(OKF_MANIFEST_FILE),
            serde_yaml::to_string(&OkfBundleManifest {
                okf_version: OKF_VERSION.to_string(),
                generated_at: "2999-01-01T00:00:00Z".to_string(),
                task: "test".to_string(),
                namespace: "/Wiki/projects/acme".to_string(),
                budget_tokens: 8_000,
                depth: 1,
                truncated: false,
                concept_count: 0,
                reference_count: 0,
                selected_nodes: Vec::new(),
            })
            .expect("manifest yaml"),
        )
        .expect("manifest");
    }

    fn write_kinic_fact(dir: &Path, content_hash: Option<String>, body: &str) -> PathBuf {
        fs::create_dir_all(dir.join("facts")).expect("facts");
        let hash_yaml = content_hash
            .map(|hash| format!("  content_hash: {hash}\n"))
            .unwrap_or_default();
        let path = dir.join("facts/fact.md");
        fs::write(
            &path,
            format!(
                "---\ntype: Fact\nresource: kinic://alpha/Wiki/projects/acme/facts.md\nkinic:\n  database_id: alpha\n  root: /Wiki/projects/acme\n{hash_yaml}---\n\n{body}\n"
            ),
        )
        .expect("fact");
        path
    }

    #[tokio::test]
    async fn export_writes_okf_concepts_without_raw_source_text() {
        let out = tempdir().expect("tempdir");
        let mut client = MockClient::default();
        client.context.nodes = vec![test_node_context(
            "/Wiki/projects/acme/facts.md",
            "Fact from /Sources/web/source.md\n",
            "wiki-etag",
        )];
        client.context.evidence = vec![test_source_evidence(
            "/Wiki/projects/acme/facts.md",
            "/Sources/web/source.md",
            "sha256:sourcehash",
        )];
        client.context.truncated = true;

        let result = export_okf_bundle(
            &client,
            "alpha",
            ContextPackExportOptions {
                task: "acme facts".to_string(),
                namespace: "/Wiki/projects/acme".to_string(),
                budget_tokens: 8_000,
                depth: 1,
                entities: vec!["acme".to_string()],
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

        assert_eq!(client.read_node_calls.load(Ordering::SeqCst), 0);
        assert_eq!(client.list_nodes_calls.load(Ordering::SeqCst), 0);
        assert_eq!(result.concept_count, 2);
        assert_eq!(result.reference_count, 1);
        assert!(result.truncated);
        let fact =
            fs::read_to_string(out.path().join("facts/wiki-projects-acme-facts.md")).expect("fact");
        assert!(fact.starts_with("---\n"));
        assert!(fact.contains("type: Fact"));
        assert!(fact.contains("Fact from /Sources/web/source.md"));
        let reference = fs::read_to_string(out.path().join("references/sources-web-source.md"))
            .expect("reference");
        assert!(reference.contains("type: Reference"));
        assert!(reference.contains("store: knowledge_evidence"));
        assert!(reference.contains("store_path: /Sources/web/source.md"));
        assert!(reference.contains("source-etag"));
        assert!(reference.contains("sha256:sourcehash"));
        assert!(!reference.contains("raw secret transcript"));
        let index = fs::read_to_string(out.path().join(INDEX_FILE)).expect("index");
        assert!(!index.starts_with("---\n"));
        assert!(index.contains("task: `acme facts`"));
        assert!(index.contains("truncated: `true`"));
        let log = fs::read_to_string(out.path().join(LOG_FILE)).expect("log");
        assert!(log.contains("truncated: true"));
        assert!(
            verify_okf_bundle_dir(out.path(), false)
                .expect("verify")
                .valid
        );
        let manifest = read_okf_manifest(out.path()).expect("manifest");
        assert_eq!(manifest.okf_version, OKF_VERSION);
        assert_eq!(manifest.task, "acme facts");
        assert_eq!(manifest.namespace, "/Wiki/projects/acme");
        assert_eq!(manifest.budget_tokens, 8_000);
        assert_eq!(manifest.depth, 1);
        assert!(manifest.truncated);
        assert_eq!(manifest.concept_count, 2);
        assert_eq!(manifest.reference_count, 1);
        assert!(manifest.selected_nodes.iter().any(|node| {
            node.path == "/Wiki/projects/acme/facts.md"
                && node.concept_type == "Fact"
                && node.etag == "wiki-etag"
                && node.output_path == "facts/wiki-projects-acme-facts.md"
        }));
        assert!(manifest.selected_nodes.iter().any(|node| {
            node.path == "/Sources/web/source.md"
                && node.concept_type == "Reference"
                && node.etag == "source-etag"
                && node.content_hash == "sha256:sourcehash"
                && node.output_path == "references/sources-web-source.md"
        }));
        let truncated_verify = verify_okf_bundle_dir(out.path(), true).expect("truncated verify");
        assert!(!truncated_verify.valid);
        assert!(
            truncated_verify
                .errors
                .iter()
                .any(|error| error.contains("truncated context"))
        );

        let fact_path = out.path().join("facts/wiki-projects-acme-facts.md");
        let mut tampered = fs::read_to_string(&fact_path).expect("fact read");
        tampered.push_str("\nTampered line\n");
        fs::write(&fact_path, tampered).expect("tamper fact");
        let tampered_verify = verify_okf_bundle_dir(out.path(), false).expect("tampered verify");
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
        client.context.nodes = vec![test_node_context(
            "/Wiki/projects/acme/summary.md",
            "Project summary",
            "summary-etag",
        )];

        let result = export_okf_bundle(
            &client,
            "alpha",
            ContextPackExportOptions {
                task: "summary".to_string(),
                namespace: "/Wiki/projects/acme".to_string(),
                budget_tokens: 8_000,
                depth: 1,
                entities: Vec::new(),
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

        let verify = verify_okf_bundle_dir(out.path(), false).expect("verify");
        assert!(verify.valid);
        assert_eq!(verify.reference_count, 0);
    }

    #[tokio::test]
    async fn export_writes_session_links_as_metadata_only_references() {
        let out = tempdir().expect("tempdir");
        let mut client = MockClient::default();
        let session_path = "/Sessions/codex/session.md";
        client.context.nodes = vec![NodeContext {
            node: test_node(
                "/Wiki/projects/acme/provenance.md",
                NodeKind::File,
                "Session [audit](/Sessions/codex/session.md)",
                "wiki-etag",
            ),
            incoming_links: Vec::new(),
            outgoing_links: vec![LinkEdge {
                source_path: "/Wiki/projects/acme/provenance.md".to_string(),
                target_path: session_path.to_string(),
                raw_href: session_path.to_string(),
                link_text: "audit".to_string(),
                link_kind: "markdown".to_string(),
                updated_at: 4,
            }],
        }];
        client.readable_nodes.insert(
            session_path.to_string(),
            test_node(
                session_path,
                NodeKind::File,
                "raw session transcript",
                "session-etag",
            ),
        );

        let result = export_okf_bundle(
            &client,
            "alpha",
            ContextPackExportOptions {
                task: "session audit".to_string(),
                namespace: "/Wiki/projects/acme".to_string(),
                budget_tokens: 8_000,
                depth: 1,
                entities: Vec::new(),
                out: out.path().to_path_buf(),
                expires_at: "2999-01-01T00:00:00Z".to_string(),
                trust_level: "team-approved".to_string(),
                approved_by: Vec::new(),
                overwrite: false,
                json: true,
            },
        )
        .await
        .expect("export");

        assert_eq!(result.reference_count, 1);
        assert_eq!(client.read_node_calls.load(Ordering::SeqCst), 1);
        let reference = fs::read_to_string(out.path().join("references/sessions-codex-session.md"))
            .expect("reference");
        assert!(reference.contains("store: session"));
        assert!(reference.contains("store_path: /Sessions/codex/session.md"));
        assert!(reference.contains("session-etag"));
        assert!(!reference.contains("raw session transcript"));
        let verify = verify_okf_bundle_dir(out.path(), false).expect("verify");
        assert!(verify.valid, "{:?}", verify.errors);
    }

    #[test]
    fn verify_rejects_missing_okf_manifest() {
        let dir = tempdir().expect("tempdir");
        fs::write(dir.path().join(INDEX_FILE), "# Index\n").expect("index");
        fs::write(dir.path().join(LOG_FILE), "# Log\n").expect("log");

        let result = verify_okf_bundle_dir(dir.path(), false).expect("verify result");
        assert!(!result.valid);
        assert!(result.errors.iter().any(|error| error.contains("okf.yaml")));
    }

    #[tokio::test]
    async fn verify_rejects_manifest_count_mismatch() {
        let out = tempdir().expect("tempdir");
        export_reference_bundle(out.path(), false).await;
        let mut manifest = read_okf_manifest(out.path()).expect("manifest");
        manifest.concept_count = 99;
        fs::write(
            out.path().join(OKF_MANIFEST_FILE),
            serde_yaml::to_string(&manifest).expect("manifest yaml"),
        )
        .expect("manifest write");

        let result = verify_okf_bundle_dir(out.path(), false).expect("verify result");
        assert!(!result.valid);
        assert!(
            result
                .errors
                .iter()
                .any(|error| error.contains("concept_count mismatch"))
        );
    }

    #[tokio::test]
    async fn verify_rejects_selected_node_hash_mismatch() {
        let out = tempdir().expect("tempdir");
        export_reference_bundle(out.path(), false).await;
        let mut manifest = read_okf_manifest(out.path()).expect("manifest");
        manifest.selected_nodes[0].content_hash = "sha256:wrong".to_string();
        fs::write(
            out.path().join(OKF_MANIFEST_FILE),
            serde_yaml::to_string(&manifest).expect("manifest yaml"),
        )
        .expect("manifest write");

        let result = verify_okf_bundle_dir(out.path(), false).expect("verify result");
        assert!(!result.valid);
        assert!(
            result
                .errors
                .iter()
                .any(|error| error.contains("selected_nodes mismatch"))
        );
    }

    #[tokio::test]
    async fn verify_rejects_reference_missing_etag_or_content_hash() {
        let out = tempdir().expect("tempdir");
        export_reference_bundle(out.path(), false).await;
        let reference_path = out.path().join("references/sources-web-source.md");
        let without_etag = fs::read_to_string(&reference_path)
            .expect("reference read")
            .replace("  etag: source-etag\n", "");
        fs::write(&reference_path, without_etag).expect("reference write");
        let missing_etag = verify_okf_bundle_dir(out.path(), false).expect("verify result");
        assert!(!missing_etag.valid);
        assert!(
            missing_etag
                .errors
                .iter()
                .any(|error| error.contains("kinic.etag"))
        );

        let out = tempdir().expect("tempdir");
        export_reference_bundle(out.path(), false).await;
        let reference_path = out.path().join("references/sources-web-source.md");
        let without_hash = fs::read_to_string(&reference_path)
            .expect("reference read")
            .replace("  content_hash: sha256:sourcehash\n", "");
        fs::write(&reference_path, without_hash).expect("reference write");
        let missing_hash = verify_okf_bundle_dir(out.path(), false).expect("verify result");
        assert!(!missing_hash.valid);
        assert!(
            missing_hash
                .errors
                .iter()
                .any(|error| error.contains("kinic.content_hash"))
        );
    }

    #[tokio::test]
    async fn verify_rejects_reference_body_extra_text() {
        let out = tempdir().expect("tempdir");
        export_reference_bundle(out.path(), false).await;
        let reference_path = out.path().join("references/sources-web-source.md");
        let mut reference = fs::read_to_string(&reference_path).expect("reference read");
        reference.push_str("\nraw source transcript should not appear\n");
        fs::write(&reference_path, reference).expect("reference write");

        let result = verify_okf_bundle_dir(out.path(), false).expect("verify result");
        assert!(!result.valid);
        assert!(
            result
                .errors
                .iter()
                .any(|error| error.contains("fixed metadata-only shape"))
        );
    }

    #[test]
    fn verify_rejects_missing_type() {
        let dir = tempdir().expect("tempdir");
        fs::write(
            dir.path().join("broken.md"),
            "---\ntitle: Broken\n---\n\n# Broken\n",
        )
        .expect("write");
        write_reserved_files(dir.path());

        let result = verify_okf_bundle_dir(dir.path(), false).expect("verify result");
        assert!(!result.valid);
        assert!(result.errors.iter().any(|error| error.contains("type")));
    }

    #[test]
    fn verify_rejects_missing_content_hash_for_kinic_concept() {
        let dir = tempdir().expect("tempdir");
        write_reserved_files(dir.path());
        write_kinic_fact(dir.path(), None, "# Fact\n\nOriginal");

        let result = verify_okf_bundle_dir(dir.path(), false).expect("verify result");
        assert!(!result.valid);
        assert!(result.errors.iter().any(|error| {
            error.contains("facts/fact.md") && error.contains("kinic.content_hash is required")
        }));
    }

    #[test]
    fn verify_rejects_tampered_body_after_hash_removed() {
        let dir = tempdir().expect("tempdir");
        write_reserved_files(dir.path());
        let fact = write_kinic_fact(
            dir.path(),
            Some(sha256_hex("# Fact\n\nOriginal".as_bytes())),
            "# Fact\n\nOriginal",
        );
        let mut tampered = fs::read_to_string(&fact)
            .expect("fact read")
            .lines()
            .filter(|line| !line.trim_start().starts_with("content_hash:"))
            .collect::<Vec<_>>()
            .join("\n");
        tampered.push_str("\nTampered line\n");
        fs::write(&fact, tampered).expect("tamper");

        let result = verify_okf_bundle_dir(dir.path(), false).expect("verify result");
        assert!(!result.valid);
        assert!(result.errors.iter().any(|error| {
            error.contains("facts/fact.md") && error.contains("kinic.content_hash is required")
        }));
    }

    #[test]
    fn verify_rejects_empty_dir() {
        let dir = tempdir().expect("tempdir");

        let result = verify_okf_bundle_dir(dir.path(), false).expect("verify result");
        assert!(!result.valid);
        assert!(result.errors.iter().any(|error| error.contains("index.md")));
    }

    #[test]
    fn verify_rejects_missing_index_or_log() {
        let dir = tempdir().expect("tempdir");
        fs::write(dir.path().join(INDEX_FILE), "# Index\n").expect("index");
        write_kinic_fact(
            dir.path(),
            Some(sha256_hex("# Fact\n\nOriginal".as_bytes())),
            "# Fact\n\nOriginal",
        );

        let missing_log = verify_okf_bundle_dir(dir.path(), false).expect("verify result");
        assert!(!missing_log.valid);
        assert!(
            missing_log
                .errors
                .iter()
                .any(|error| error.contains("log.md"))
        );

        fs::remove_file(dir.path().join(INDEX_FILE)).expect("remove index");
        fs::write(dir.path().join(LOG_FILE), "# Log\n").expect("log");
        let missing_index = verify_okf_bundle_dir(dir.path(), false).expect("verify result");
        assert!(!missing_index.valid);
        assert!(
            missing_index
                .errors
                .iter()
                .any(|error| error.contains("index.md"))
        );
    }

    #[test]
    fn verify_rejects_only_reserved_files() {
        let dir = tempdir().expect("tempdir");
        write_reserved_files(dir.path());

        let result = verify_okf_bundle_dir(dir.path(), false).expect("verify result");
        assert!(result.valid);
        assert_eq!(result.concept_count, 0);
    }

    #[test]
    fn verify_rejects_expired_kinic_context() {
        let dir = tempdir().expect("tempdir");
        write_reserved_files(dir.path());
        fs::write(
            dir.path().join("expired.md"),
            "---\ntype: Fact\nkinic:\n  expires_at: 2000-01-01T00:00:00Z\n---\n\n# Expired\n",
        )
        .expect("write");

        let result = verify_okf_bundle_dir(dir.path(), false).expect("verify result");
        assert!(!result.valid);
        assert!(
            result
                .errors
                .iter()
                .any(|error| error.contains("kinic.expires_at"))
        );
    }

    #[test]
    fn verify_rejects_reference_without_kinic_store_metadata() {
        let dir = tempdir().expect("tempdir");
        write_reserved_files(dir.path());
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

        let result = verify_okf_bundle_dir(dir.path(), false).expect("verify result");
        assert!(!result.valid);
        assert_eq!(result.reference_count, 2);
        assert!(
            result
                .errors
                .iter()
                .any(|error| error.contains("missing-kinic.md") && error.contains("kinic.store"))
        );
        assert!(
            result
                .errors
                .iter()
                .any(|error| error.contains("reference-no-source-path.md")
                    && error.contains("kinic.store"))
        );
    }

    #[test]
    fn verify_rejects_non_reference_type_under_references() {
        let dir = tempdir().expect("tempdir");
        write_reserved_files(dir.path());
        fs::create_dir_all(dir.path().join("references")).expect("refs");
        fs::write(
            dir.path().join("references/source.md"),
            "---\ntype: Fact\nkinic:\n  database_id: alpha\n  root: /Wiki/projects/acme\n  store: knowledge_evidence\n  store_path: /Sources/web/source.md\n---\n\n# Source\n",
        )
        .expect("write");

        let result = verify_okf_bundle_dir(dir.path(), false).expect("verify result");
        assert!(!result.valid);
        assert!(result.errors.iter().any(|error| {
            error.contains("references/source.md") && error.contains("type: Reference")
        }));
    }

    #[test]
    fn verify_rejects_reference_type_outside_references() {
        let dir = tempdir().expect("tempdir");
        write_reserved_files(dir.path());
        fs::write(
            dir.path().join("source.md"),
            "---\ntype: Reference\nkinic:\n  store: knowledge_evidence\n  store_path: /Sources/web/source.md\n---\n\n# Source\n",
        )
        .expect("write");

        let result = verify_okf_bundle_dir(dir.path(), false).expect("verify result");
        assert!(!result.valid);
        assert!(result.errors.iter().any(|error| {
            error.contains("source.md") && error.contains("must be under references/")
        }));
    }

    #[test]
    fn verify_rejects_reference_store_path_outside_store_roots() {
        let dir = tempdir().expect("tempdir");
        write_reserved_files(dir.path());
        fs::create_dir_all(dir.path().join("references")).expect("refs");
        fs::write(
            dir.path().join("references/bad.md"),
            "---\ntype: Reference\nkinic:\n  database_id: alpha\n  root: /Wiki/projects/acme\n  store: knowledge\n  store_path: /Bad/root.md\n  etag: bad-etag\n  content_hash: sha256:bad\n  expires_at: 2999-01-01T00:00:00Z\n---\n\n# Reference\n\n- store: `knowledge`\n- store_path: `/Bad/root.md`\n- via_path: `/Wiki/projects/acme/facts.md`\n- target_href: `/Bad/root.md`\n- link_text: `Bad`\n- etag: `bad-etag`\n- updated_at: `3`\n- content_hash: `sha256:bad`\n\nReferenced store content is not copied into this OKF bundle.\n",
        )
        .expect("write");

        let result = verify_okf_bundle_dir(dir.path(), false).expect("verify result");
        assert!(!result.valid);
        assert!(result.errors.iter().any(|error| {
            error.contains("references/bad.md") && error.contains("outside supported store roots")
        }));
    }

    #[test]
    fn reference_store_mapping_covers_four_store_roots_and_evidence_roots() {
        assert_eq!(reference_store_for_path("/Memory/facts.md"), Some("memory"));
        assert_eq!(reference_store_for_path("/Wiki/page.md"), Some("knowledge"));
        assert_eq!(
            reference_store_for_path("/Wiki/skills/review/SKILL.md"),
            Some("skill")
        );
        assert_eq!(
            reference_store_for_path("/Sessions/codex/session.md"),
            Some("session")
        );
        assert_eq!(
            reference_store_for_path("/Sources/web/source.md"),
            Some("knowledge_evidence")
        );
        assert_eq!(
            reference_store_for_path("/Sources/sessions/session-1/session-1.md"),
            Some("session_evidence")
        );
        assert_eq!(
            reference_store_for_path("/Sources/sessions/session-1/bad.md"),
            None
        );
        assert_eq!(
            reference_store_for_path("/Sources/skill-runs/review/run-1.md"),
            Some("skill_run_evidence")
        );
        assert_eq!(reference_store_for_path("/Sources/skill-runs/review"), None);
        assert_eq!(reference_store_for_path("/Bad/root.md"), None);
    }

    #[tokio::test]
    async fn overwrite_removes_owned_bundle_subdirs() {
        let out = tempdir().expect("tempdir");
        for dir_name in OKF_OWNED_DIRS {
            fs::create_dir_all(out.path().join(dir_name).join("nested")).expect("owned dir");
            fs::write(
                out.path().join(dir_name).join("nested/stale.txt"),
                "stale owned artifact",
            )
            .expect("stale owned");
        }
        fs::write(out.path().join(INDEX_FILE), "# Old\n").expect("old index");
        fs::write(out.path().join(LOG_FILE), "# Old\n").expect("old log");
        fs::write(out.path().join("manifest.json"), "{}").expect("manifest");
        fs::write(out.path().join("unrelated.txt"), "keep").expect("unrelated");

        let mut client = MockClient::default();
        client.context.nodes = vec![test_node_context(
            "/Wiki/projects/acme/facts.md",
            "Fact",
            "wiki-etag",
        )];

        export_okf_bundle(
            &client,
            "alpha",
            ContextPackExportOptions {
                task: "facts".to_string(),
                namespace: "/Wiki/projects/acme".to_string(),
                budget_tokens: 8_000,
                depth: 1,
                entities: Vec::new(),
                out: out.path().to_path_buf(),
                expires_at: "2999-01-01T00:00:00Z".to_string(),
                trust_level: "team-approved".to_string(),
                approved_by: Vec::new(),
                overwrite: true,
                json: true,
            },
        )
        .await
        .expect("export");

        assert!(out.path().join("unrelated.txt").is_file());
        assert!(!out.path().join("manifest.json").exists());
        assert!(!out.path().join("facts/nested/stale.txt").exists());
        assert!(
            out.path()
                .join("facts/wiki-projects-acme-facts.md")
                .is_file()
        );
        assert!(
            verify_okf_bundle_dir(out.path(), false)
                .expect("verify")
                .valid
        );
    }

    #[test]
    fn inspect_reports_counts_and_kinic_summary() {
        let dir = tempdir().expect("tempdir");
        fs::write(
            dir.path().join(OKF_MANIFEST_FILE),
            serde_yaml::to_string(&OkfBundleManifest {
                okf_version: OKF_VERSION.to_string(),
                generated_at: "2999-01-01T00:00:00Z".to_string(),
                task: "inspect".to_string(),
                namespace: "/Wiki/projects/acme".to_string(),
                budget_tokens: 8_000,
                depth: 1,
                truncated: true,
                concept_count: 1,
                reference_count: 1,
                selected_nodes: vec![OkfSelectedNode {
                    path: "/Sources/web/source.md".to_string(),
                    concept_type: "Reference".to_string(),
                    etag: "source-etag".to_string(),
                    content_hash: "sha256:sourcehash".to_string(),
                    output_path: "references/source.md".to_string(),
                }],
            })
            .expect("manifest yaml"),
        )
        .expect("manifest");
        fs::create_dir_all(dir.path().join("references")).expect("refs");
        fs::write(
            dir.path().join("references/source.md"),
            "---\ntype: Reference\nkinic:\n  database_id: alpha\n  root: /Wiki/projects/acme\n  store: knowledge_evidence\n  store_path: /Sources/web/source.md\n  etag: source-etag\n  content_hash: sha256:sourcehash\n  expires_at: 2999-01-01T00:00:00Z\n---\n\n# Reference\n\n- store: `knowledge_evidence`\n- store_path: `/Sources/web/source.md`\n- via_path: `/Wiki/projects/acme/facts.md`\n- target_href: `/Sources/web/source.md`\n- link_text: `Raw`\n- etag: `source-etag`\n- updated_at: `3`\n- content_hash: `sha256:sourcehash`\n\nReferenced store content is not copied into this OKF bundle.\n",
        )
        .expect("write");

        let result = inspect_okf_bundle_dir(dir.path()).expect("inspect");
        assert_eq!(result.concept_count, 1);
        assert_eq!(result.reference_count, 1);
        assert_eq!(result.task, "inspect");
        assert_eq!(result.namespace, "/Wiki/projects/acme");
        assert_eq!(result.budget_tokens, 8_000);
        assert_eq!(result.depth, 1);
        assert!(result.truncated);
        assert_eq!(result.types.get("Reference"), Some(&1));
        assert_eq!(result.kinic.database_ids, vec!["alpha"]);
        assert_eq!(result.kinic.roots, vec!["/Wiki/projects/acme"]);
    }

    #[tokio::test]
    async fn export_allows_empty_memory_recall() {
        let out = tempdir().expect("tempdir");
        let client = MockClient::default();

        let result = export_okf_bundle(
            &client,
            "alpha",
            ContextPackExportOptions {
                task: "missing".to_string(),
                namespace: "/Wiki/projects/acme".to_string(),
                budget_tokens: 8_000,
                depth: 1,
                entities: Vec::new(),
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

        assert_eq!(result.concept_count, 0);
        assert_eq!(result.reference_count, 0);
        let index = fs::read_to_string(out.path().join(INDEX_FILE)).expect("index");
        assert!(index.contains("No context nodes matched this task."));
        assert!(
            verify_okf_bundle_dir(out.path(), false)
                .expect("verify")
                .valid
        );
    }
}
