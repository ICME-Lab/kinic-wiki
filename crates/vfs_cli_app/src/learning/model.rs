//! Durable learning records. Execution termination and verified task outcomes are independent.
use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use vfs_types::{Node, RevisionRef, WriteNodeItem};

pub fn hash(text: &str) -> String {
    hex::encode(Sha256::digest(text.as_bytes()))
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Event {
    pub id: String,
    pub run_id: String,
    pub kind: String,
    pub payload: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Run {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    pub id: String,
    pub task: String,
    pub engine: String,
    pub model: Option<String>,
    pub settings: Value,
    pub repository: String,
    pub start_commit: Option<String>,
    pub starting_diff: String,
    pub environment: Value,
    pub receipt_id: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CheckResult {
    pub argv: Vec<String>,
    pub exit_code: Option<i32>,
    pub output_hash: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Outcome {
    pub claimed_success: Option<bool>,
    pub checks: Vec<CheckResult>,
    pub complete: bool,
    pub requirements_met: Option<bool>,
}
impl Outcome {
    pub fn verified_success(&self) -> bool {
        self.complete
            && self.requirements_met == Some(true)
            && !self.checks.is_empty()
            && self.checks.iter().all(|c| c.exit_code == Some(0))
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SuppliedNode {
    pub metadata_json: String,
    pub authority: Option<String>,
    pub reference: Option<RevisionRef>,
    pub path: String,
    pub etag: String,
    pub source_hash: String,
    pub content: String,
    pub content_hash: String,
    pub truncated: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ContextReceipt {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    pub id: String,
    pub run_id: String,
    pub candidates: Vec<String>,
    pub supplied: Vec<SuppliedNode>,
    pub rendered: String,
    pub truncated: bool,
    pub index_model: Option<String>,
    #[serde(default)]
    pub scope_guard: Option<vfs_types::ScopeRevisionGuard>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub scope_guards: Vec<vfs_types::ScopeRevisionGuard>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Lesson {
    pub body: String,
    pub applies_to: Vec<String>,
    pub exceptions: Vec<String>,
    pub evidence: Vec<RevisionRef>,
    pub environment: Value,
    pub state: String,
    pub dependencies: Vec<String>,
    pub authority: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RevisionCandidate {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(default)]
    pub historical_evidence: Vec<RevisionRef>,
    pub id: String,
    pub source_run: String,
    pub operation: String,
    pub rationale: String,
    pub targets: Vec<WriteNodeItem>,
    pub evidence: Vec<RevisionRef>,
    pub baseline: Vec<Node>,
    pub dependency_paths: Vec<String>,
}
impl RevisionCandidate {
    pub fn fingerprint(&self) -> Result<String> {
        Ok(hash(&serde_json::to_string(self)?))
    }
    pub fn validate(&self) -> Result<()> {
        if self.evidence.is_empty() || self.targets.is_empty() || self.rationale.trim().is_empty() {
            bail!("candidate requires targets, rationale and source evidence");
        }
        if ![
            "keep",
            "condition",
            "correct",
            "split",
            "merge",
            "deprecate",
            "new",
            "rollback",
        ]
        .contains(&self.operation.as_str())
        {
            bail!("unsupported revision operation");
        }
        for target in &self.targets {
            let metadata: Value = serde_json::from_str(&target.metadata_json)?;
            if !agent_mutable(&metadata) {
                bail!("candidate target must explicitly have agent authority");
            }
            if !(target.path.starts_with("/Knowledge/")
                || target.path.starts_with("/Skills/")
                || target.path.starts_with("/Memory/"))
            {
                bail!("candidate target outside learning stores");
            }
        }
        Ok(())
    }
}
pub fn agent_mutable(metadata: &Value) -> bool {
    metadata.get("authority").and_then(Value::as_str) == Some("agent")
        && metadata.get("protected").and_then(Value::as_bool) != Some(true)
        && metadata.get("approved").and_then(Value::as_bool) != Some(true)
        && !matches!(
            metadata.get("kind").and_then(Value::as_str),
            Some("instruction" | "decision")
        )
}
/// One complete JSON record per supplied node. Metadata and framing count toward
/// the budget, so this string can be sent verbatim to a hook or agent runner.
#[derive(Serialize)]
struct ContextFrame<'a> {
    path: &'a str,
    authority: Option<&'a str>,
    metadata_json: &'a str,
    content: &'a str,
    truncated: bool,
}

pub fn assemble_context(
    run_id: &str,
    nodes: Vec<Node>,
    budget_tokens: usize,
) -> Result<ContextReceipt> {
    if budget_tokens == 0 {
        bail!("budget_tokens must be positive");
    }
    let mut receipt = ContextReceipt {
        project_id: None,
        scope_guards: vec![],
        id: String::new(),
        run_id: run_id.into(),
        candidates: nodes.iter().map(|node| node.path.clone()).collect(),
        supplied: vec![],
        rendered: String::new(),
        truncated: false,
        index_model: None,
        scope_guard: None,
    };
    let mut seen = std::collections::BTreeSet::new();
    let mut remaining = budget_tokens.saturating_mul(4);
    for node in nodes {
        if !seen.insert(node.path.clone()) {
            continue;
        }
        let metadata: Value = serde_json::from_str(&node.metadata_json)?;
        if matches!(
            metadata.get("state").and_then(Value::as_str),
            Some("deprecated" | "superseded" | "invalidated")
        ) {
            continue;
        }
        if remaining == 0 {
            receipt.truncated = true;
            break;
        }
        let authority = metadata
            .get("authority")
            .and_then(Value::as_str)
            .map(str::to_string);
        let render = |content: &str| -> Result<String> {
            let mut frame = serde_json::to_string(&ContextFrame {
                path: &node.path,
                authority: authority.as_deref(),
                metadata_json: &node.metadata_json,
                content,
                truncated: content.len() != node.content.len(),
            })?;
            frame.push('\n');
            Ok(frame)
        };
        if render("")?.chars().count() > remaining {
            receipt.truncated = true;
            continue;
        }
        // JSON escaping can expand a character to several supplied characters.
        // Search Unicode boundaries and budget the actual final serialized frame.
        let characters: Vec<char> = node.content.chars().take(remaining).collect();
        let mut low = 0;
        let mut high = characters.len();
        while low < high {
            let middle = low + (high - low).div_ceil(2);
            let content: String = characters[..middle].iter().collect();
            if render(&content)?.chars().count() <= remaining {
                low = middle;
            } else {
                high = middle - 1;
            }
        }
        let content: String = characters[..low].iter().collect();
        let frame = render(&content)?;
        let truncated = content.len() != node.content.len();
        remaining -= frame.chars().count();
        receipt.rendered.push_str(&frame);
        receipt.supplied.push(SuppliedNode {
            metadata_json: node.metadata_json,
            authority,
            reference: None,
            path: node.path,
            etag: node.etag,
            source_hash: hash(&node.content),
            content_hash: hash(&content),
            content,
            truncated,
        });
        receipt.truncated |= truncated;
    }
    receipt.id = hash(&serde_json::to_string(&receipt)?);
    Ok(receipt)
}
