//! Failure evidence deliberately excludes prompts, model text and error messages.
use crate::learning_runner::{AgentEngine, Execution};
use serde_json::{Value, json};
use std::{collections::HashSet, io::Write, path::Path};

fn exit_reason(result: Option<&Execution>) -> &'static str {
    match result.map(|r| r.exit_reason.as_str()) {
        None => "unavailable",
        Some("completed") => "completed",
        Some("timeout") => "timeout",
        Some("output_limit") => "output_limit",
        Some("malformed_jsonl") => "malformed_jsonl",
        Some("truncated_jsonl") => "truncated_jsonl",
        Some("missing_terminal") => "missing_terminal",
        Some("protocol_error") => "protocol_error",
        Some("turn_error") => "turn_error",
        Some("turn_failed") => "turn_failed",
        Some("turn_cancelled") => "turn_cancelled",
        _ => "unknown",
    }
}

fn provider_failure(result: &Execution) -> (&'static str, Option<u64>) {
    // Execution retains SDK replies and descendant events, but no initialize
    // request. Identify the root from its acknowledged prompt receipt, excluding
    // every known child. Ambiguous receipts fail closed to unknown.
    let receipts: HashSet<_> = result
        .events
        .iter()
        .filter_map(|e| {
            (e["jsonrpc"] == "2.0" && e["id"] == 2 && e.get("error").is_none())
                .then(|| e["result"]["messageId"].as_str())
                .flatten()
                .filter(|id| !id.is_empty())
        })
        .collect();
    if receipts.len() != 1 {
        return ("unknown", None);
    }
    let receipt = *receipts.iter().next().unwrap();
    let children: HashSet<_> = result
        .events
        .iter()
        .filter_map(|e| {
            (e["method"] == "subagent.started")
                .then(|| e["params"]["childSessionId"].as_str())
                .flatten()
        })
        .collect();
    let roots: HashSet<_> = result
        .events
        .iter()
        .filter_map(|e| {
            let p = &e["params"];
            let session = p["sessionId"].as_str()?;
            (e["method"] == "session.event"
                && p["event"]["type"] == "agent/inbox/spliced"
                && !children.contains(session)
                && p["event"]["data"]["inserted"]
                    .as_array()?
                    .iter()
                    .any(|m| m["id"] == receipt))
            .then_some(session)
        })
        .collect();
    if roots.len() != 1 {
        return ("unknown", None);
    }
    let root = *roots.iter().next().unwrap();
    let mut received = false;
    let mut terminal = None;
    for e in &result.events {
        if e["method"] != "session.event" || e["params"]["sessionId"] != root {
            continue;
        }
        let event = &e["params"]["event"];
        if event["type"] == "agent/inbox/spliced"
            && event["data"]["inserted"]
                .as_array()
                .is_some_and(|items| items.iter().any(|m| m["id"] == receipt))
        {
            received = true;
        }
        if received && event["type"] == "turn/end" {
            terminal = Some(&event["data"]["reason"]);
        }
    }
    let Some(reason) = terminal.filter(|r| r["kind"] == "error") else {
        return ("unknown", None);
    };
    let error = &reason["error"];
    let category = match error["code"].as_str() {
        Some("QUOTA") => "QUOTA",
        Some("AUTH") => "AUTH",
        Some("RATE_LIMIT") => "RATE_LIMIT",
        Some("TIMEOUT") => "TIMEOUT",
        _ => "unknown",
    };
    (
        category,
        error["status"]
            .as_u64()
            .filter(|status| (100..=599).contains(status)),
    )
}

pub(super) fn record(
    dir: &Path,
    engine: &AgentEngine,
    role: &str,
    phase: &'static str,
    result: Option<&Execution>,
    original: anyhow::Error,
) -> anyhow::Error {
    let (category, status) = if *engine == AgentEngine::Dsh {
        result.map(provider_failure).unwrap_or(("unknown", None))
    } else {
        ("unknown", None)
    };
    let diagnostic = json!({
        "schema_version": 1,
        "role": match role {"write" => "write", "revision" => "revision", "selection" => "selection", _ => "unknown"},
        "phase": phase,
        "exit_reason": exit_reason(result),
        "provider_category": category,
        "http_status": status,
        "elapsed_ms": result.map(|r| r.elapsed_ms),
        "input_tokens": result.and_then(|r| r.input_tokens),
        "output_tokens": result.and_then(|r| r.output_tokens),
    });
    match persist(dir, &diagnostic) {
        Ok(()) => original,
        // Keep the original cause in the chain, but do not copy filesystem paths
        // or arbitrary OS error strings into the diagnostic or new context.
        Err(_) => original.context("inference failure diagnostic could not be persisted"),
    }
}

fn persist(dir: &Path, diagnostic: &Value) -> anyhow::Result<()> {
    let pending = dir.join("failure.json.pending");
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&pending)?;
    let outcome = (|| -> anyhow::Result<()> {
        file.write_all(&serde_json::to_vec_pretty(diagnostic)?)?;
        file.sync_all()?;
        // Atomic publication without overwriting an existing file or symlink.
        std::fs::hard_link(&pending, dir.join("failure.json"))?;
        Ok(())
    })();
    drop(file);
    let cleanup = std::fs::remove_file(pending);
    outcome?;
    cleanup?;
    Ok(())
}
