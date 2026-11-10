//! Owned Claude Code print transport. No hooks, inherited MCP or private thinking.
use super::*;
use anyhow::{Result, ensure};

pub(super) fn configure(command: &mut Command, config: &RunnerConfig) -> Result<()> {
    ensure!(
        config.extra_args.is_empty(),
        "Claude extra_args are unsupported: runner policy must not be overridden"
    );
    if let Some(effort) = &config.reasoning_effort {
        ensure!(
            ["low", "medium", "high", "xhigh", "max"].contains(&effort.as_str()),
            "unsupported Claude reasoning_effort"
        );
        command.args(["--effort", effort]);
    }
    if let Some(model) = &config.model {
        command.args(["--model", model]);
    }
    // Provider selection remains available; CLI customization environment does not.
    let names: HashSet<_> = std::env::vars_os()
        .map(|(name, _)| name)
        .chain(config.environment.keys().map(Into::into))
        .chain(config.inherited_environment.iter().map(Into::into))
        .collect();
    for name in names {
        let text = name.to_string_lossy();
        if text.starts_with("CLAUDE_")
            && ![
                "CLAUDE_CODE_USE_BEDROCK",
                "CLAUDE_CODE_USE_VERTEX",
                "CLAUDE_CODE_USE_FOUNDRY",
            ]
            .contains(&text.as_ref())
        {
            command.env_remove(name);
        }
    }
    command.env("KINIC_LEARNING_OWNED_RUN", "1");
    command.args([
        "--print",
        "--input-format",
        "text",
        "--output-format",
        "stream-json",
        "--verbose",
        "--bare",
        "--restricted",
        "--no-session-persistence",
        "--strict-mcp-config",
        "--mcp-config",
        "{\"mcpServers\":{}}",
        "--disallowedTools",
        "mcp__*",
        "--settings",
        "{\"disableAllHooks\":true}",
        "--tools",
        if config.read_only {
            "Read,Glob,Grep"
        } else {
            "Read,Glob,Grep,Edit,Write,Bash"
        },
        "--allowedTools",
        if config.read_only {
            "Read,Glob,Grep"
        } else {
            "Read,Glob,Grep,Edit,Write,Bash"
        },
        "--permission-mode",
        if config.read_only {
            "plan"
        } else {
            "acceptEdits"
        },
    ]);
    Ok(())
}

/// Probe only at explicit execution, never during setup/doctor. Bound and reap it.
pub(super) async fn check_version(config: &RunnerConfig, cwd: &Path) -> Result<()> {
    let mut command = Command::new(&config.executable);
    command
        .arg("--version")
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    if config.env_clear {
        command.env_clear();
    }
    command
        .envs(&config.environment)
        .envs(config.inherited_values()?);
    let mut child = command
        .spawn()
        .map_err(|_| anyhow::anyhow!("cannot start Claude version check"))?;
    let stdout = child.stdout.take().expect("piped stdout");
    let mut bytes = Vec::new();
    let result = tokio::time::timeout(Duration::from_secs(config.timeout_seconds.min(5)), async {
        stdout.take(4097).read_to_end(&mut bytes).await?;
        if bytes.len() > 4096 {
            return Err(anyhow::anyhow!("Claude version output exceeds limit"));
        }
        let status = child.wait().await?;
        ensure!(status.success(), "Claude version check failed");
        let text = std::str::from_utf8(&bytes)
            .map_err(|_| anyhow::anyhow!("invalid Claude version output"))?;
        let version: Vec<u64> = text
            .split_whitespace()
            .next()
            .unwrap_or("")
            .split('.')
            .map(str::parse)
            .collect::<std::result::Result<_, _>>()
            .unwrap_or_default();
        ensure!(
            version.len() == 3
                && version.as_slice() >= [2, 1, 286].as_slice()
                && text.contains("Claude Code"),
            "Claude Code >=2.1.286 is required for owned execution"
        );
        Ok(())
    })
    .await;
    // Includes timeout/read/output failures; kill_on_drop alone would not reap.
    if child.try_wait()?.is_none() {
        let _ = child.start_kill();
        child.wait().await?;
    }
    result.map_err(|_| anyhow::anyhow!("Claude version check timed out"))?
}

/// Strip private reasoning before any event is retained, including nested blocks.
pub(crate) fn public_event(value: Value) -> Value {
    if matches!(
        value["type"].as_str(),
        Some("thinking" | "redacted_thinking" | "thinking_delta" | "signature_delta")
    ) {
        return Value::Null;
    }
    match value {
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .filter(|v| {
                    !matches!(
                        v["type"].as_str(),
                        Some(
                            "thinking" | "redacted_thinking" | "thinking_delta" | "signature_delta"
                        )
                    )
                })
                .map(public_event)
                .collect(),
        ),
        Value::Object(items) => Value::Object(
            items
                .into_iter()
                .filter(|(key, _)| !["thinking", "signature"].contains(&key.as_str()))
                .map(|(key, value)| (key, public_event(value)))
                .collect(),
        ),
        other => other,
    }
}

impl State {
    pub(super) fn claude(&mut self, event: Value) -> Result<()> {
        ensure!(!self.done, "Claude output after terminal result");
        if event["type"] == "result" {
            self.done = true;
            let denied = event
                .get("permission_denials")
                .is_some_and(|value| !value.as_array().is_some_and(Vec::is_empty));
            let success = event["subtype"] == "success" && event["is_error"] == false && !denied;
            self.execution.exit_reason = if success { "completed" } else { "turn_failed" }.into();
            if let Some(text) = event["result"].as_str() {
                self.execution.output = text.into();
            }
            if success && !event["result"].is_string() {
                self.execution.exit_reason = "protocol_error".into();
            }
            let usage = &event["usage"];
            self.execution.input_tokens = usage["input_tokens"].as_u64().map(|input| {
                input
                    .saturating_add(usage["cache_creation_input_tokens"].as_u64().unwrap_or(0))
                    .saturating_add(usage["cache_read_input_tokens"].as_u64().unwrap_or(0))
            });
            self.execution.output_tokens = usage["output_tokens"].as_u64();
        }
        self.execution.events.push(public_event(event));
        Ok(())
    }
}
