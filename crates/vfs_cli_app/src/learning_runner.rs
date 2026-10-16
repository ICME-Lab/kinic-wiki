//! Owned external-agent execution with bounded transport evidence.
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::{
    collections::{BTreeMap, HashSet},
    process::Stdio,
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::{ChildStdin, Command},
    sync::mpsc,
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentEngine {
    Codex,
    Dsh,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct RunnerConfig {
    pub engine: AgentEngine,
    pub executable: PathBuf,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub timeout_seconds: u64,
    pub max_output_bytes: usize,
    pub extra_args: Vec<String>,
    pub read_only: bool,
    pub env_clear: bool,
    pub environment: BTreeMap<String, String>,
    /// Variable names only; values are resolved at execution and never stored.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub inherited_environment: Vec<String>,
}
impl Default for RunnerConfig {
    fn default() -> Self {
        Self {
            engine: AgentEngine::Codex,
            executable: "codex".into(),
            model: None,
            reasoning_effort: None,
            timeout_seconds: 300,
            max_output_bytes: 8 * 1024 * 1024,
            extra_args: vec![],
            read_only: false,
            env_clear: false,
            environment: BTreeMap::new(),
            inherited_environment: vec![],
        }
    }
}
impl RunnerConfig {
    pub(crate) fn inherited_values(&self) -> anyhow::Result<BTreeMap<String, String>> {
        let mut values = BTreeMap::new();
        for name in &self.inherited_environment {
            anyhow::ensure!(
                !name.is_empty()
                    && !name.starts_with(|c: char| c.is_ascii_digit())
                    && name
                        .chars()
                        .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
                    && ![
                        "HOME",
                        "TMPDIR",
                        "PATH",
                        "CARGO_TARGET_DIR",
                        "PYTHONDONTWRITEBYTECODE",
                        "DSH_PERMISSION_MODE"
                    ]
                    .contains(&name.as_str()),
                "invalid inherited environment variable name or reserved task environment variable"
            );
            let value = std::env::var(name)
                .ok()
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "required inherited environment variable is unavailable: {name}"
                    )
                })?;
            values.insert(name.clone(), value);
        }
        Ok(values)
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Execution {
    pub events: Vec<serde_json::Value>,
    pub output: String,
    pub exit_reason: String,
    pub elapsed_ms: u64,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub complete: bool,
}

/// Launch a fresh owned agent. Transport failures return incomplete evidence;
/// invalid configuration and process launch failures return errors.
pub async fn execute(config: &RunnerConfig, cwd: &Path, prompt: &str) -> anyhow::Result<Execution> {
    anyhow::ensure!(
        config.timeout_seconds > 0,
        "timeout_seconds must be positive"
    );
    anyhow::ensure!(
        config.max_output_bytes > 0,
        "max_output_bytes must be positive"
    );
    for argument in &config.extra_args {
        let option = argument.split('=').next().unwrap_or(argument);
        let forbidden = match config.engine {
            AgentEngine::Codex => {
                [
                    "--model",
                    "-m",
                    "--config",
                    "-c",
                    "--sandbox",
                    "-s",
                    "--profile",
                    "-p",
                    "--cd",
                    "-C",
                    "--worktree",
                    "--dangerously-bypass-approvals-and-sandbox",
                    "--dangerously-bypass-hook-trust",
                    "--ignore-user-config",
                    "--ignore-rules",
                ]
                .contains(&option)
                    || argument.starts_with("-c")
                    || argument.starts_with("-m")
                    || argument.starts_with("-s")
                    || argument.starts_with("-p")
                    || argument.starts_with("-C")
            }
            AgentEngine::Dsh => option == "--profile" || (config.read_only && option == "--patch"),
        };
        anyhow::ensure!(
            !forbidden,
            "extra_args cannot override runner policy: {argument}"
        );
    }
    let started = Instant::now();
    let mut command = Command::new(&config.executable);
    command
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if config.env_clear {
        command.env_clear();
    }
    command.envs(&config.environment);
    command.envs(config.inherited_values()?);
    match config.engine {
        AgentEngine::Codex => {
            command.args(["exec", "--json", "--cd"]).arg(cwd).args([
                "--sandbox",
                if config.read_only {
                    "read-only"
                } else {
                    "workspace-write"
                },
            ]);
            if let Some(model) = &config.model {
                command.args(["--model", model]);
            }
            if let Some(effort) = &config.reasoning_effort {
                command.arg("--config").arg(format!(
                    "model_reasoning_effort={}",
                    serde_json::to_string(effort)?
                ));
            }
            command.args(&config.extra_args).arg("-");
        }
        AgentEngine::Dsh => {
            // The shipped sdk profile reads this mode in dsh-base's sandbox-policy.
            // Apply it after caller environment to prevent inherited broad access.
            command.env(
                "DSH_PERMISSION_MODE",
                if config.read_only {
                    "read-only"
                } else {
                    "workspace-write"
                },
            );
            command.args(["--profile", "sdk"]).args(&config.extra_args);
        }
    }
    let mut child = command.spawn()?;
    let mut stdin = child.stdin.take();
    let (sender, mut receiver) = mpsc::channel(8);
    let stdout = spawn_reader(
        child.stdout.take().expect("piped stdout"),
        false,
        sender.clone(),
    );
    let stderr = spawn_reader(child.stderr.take().expect("piped stderr"), true, sender);
    let readers = ReaderTasks(stdout, stderr);
    let root = format!(
        "kinic-learning-{}-{}",
        std::process::id(),
        started.elapsed().as_nanos()
    );
    let mut state = State::new(root);
    let drive = async {
        match config.engine {
            AgentEngine::Codex => {
                stdin
                    .as_mut()
                    .expect("piped stdin")
                    .write_all(prompt.as_bytes())
                    .await?;
                drop(stdin.take());
            }
            AgentEngine::Dsh => {
                let route = config.model.as_deref().unwrap_or("deepseek-chat");
                let (provider, model) = route.split_once('/').unwrap_or(("deepseek", route));
                let mut params = json!({"cwd":cwd,"provider":provider,"model":model});
                if let Some(effort) = &config.reasoning_effort {
                    params["reasoningEffort"] = effort.clone().into();
                }
                send_rpc(
                    stdin.as_mut().expect("piped stdin"),
                    1,
                    "initialize",
                    params,
                )
                .await?;
            }
        }
        let mut count = 0usize;
        while let Some(chunk) = receiver.recv().await {
            let chunk = chunk?;
            let remaining = config.max_output_bytes.saturating_sub(count);
            let retained = &chunk.bytes[..chunk.bytes.len().min(remaining)];
            count = count.saturating_add(chunk.bytes.len());
            if count > config.max_output_bytes {
                state.execution.events.push(json!({"stream":if chunk.stderr { "stderr" } else { "stdout" },"text":String::from_utf8_lossy(retained),"partial":true}));
                state.execution.exit_reason = "output_limit".into();
                return Ok::<(), anyhow::Error>(());
            }
            if chunk.stderr {
                state
                    .execution
                    .events
                    .push(json!({"stream":"stderr","text":String::from_utf8_lossy(retained)}));
            } else {
                state.pending.extend_from_slice(retained);
                while let Some(end) = state.pending.iter().position(|b| *b == b'\n') {
                    let bytes: Vec<u8> = state.pending.drain(..=end).collect();
                    if bytes.iter().all(u8::is_ascii_whitespace) {
                        continue;
                    }
                    let value: Value = match serde_json::from_slice(&bytes) {
                        Ok(Value::Object(value)) => Value::Object(value),
                        _ => {
                            state.execution.events.push(
                                json!({"stream":"stdout","text":String::from_utf8_lossy(&bytes)}),
                            );
                            state.execution.exit_reason = "malformed_jsonl".into();
                            return Ok::<(), anyhow::Error>(());
                        }
                    };
                    match config.engine {
                        AgentEngine::Codex => state.codex(value),
                        AgentEngine::Dsh => {
                            let initialized = state.dsh(value)?;
                            if initialized {
                                send_rpc(stdin.as_mut().expect("piped stdin"),2,"session/prompt",json!({"sessionId":state.root,"contentBlocks":[{"type":"text","text":prompt}]})).await?;
                            }
                            if state.done {
                                return Ok(());
                            }
                        }
                    }
                }
            }
        }
        if !state.pending.is_empty() {
            state.execution.exit_reason = "truncated_jsonl".into();
        } else if !state.done {
            state.execution.exit_reason = "missing_terminal".into();
        }
        Ok(())
    };
    let deadline = tokio::time::Instant::now() + Duration::from_secs(config.timeout_seconds);
    match tokio::time::timeout_at(deadline, drive).await {
        Err(_) => state.execution.exit_reason = "timeout".into(),
        Ok(Err(error)) => {
            state
                .execution
                .events
                .push(json!({"runner_error":error.to_string()}));
            state.execution.exit_reason = "protocol_error".into();
        }
        Ok(Ok(())) => {}
    }
    if !state.pending.is_empty() {
        state.execution.events.push(json!({"stream":"stdout","text":String::from_utf8_lossy(&state.pending),"partial":true}));
    }
    let expected_success = state.done && state.execution.exit_reason == "completed";
    if config.engine == AgentEngine::Dsh && expected_success {
        // SDK has no per-prompt cancellation. Shut down only this owned runtime.
        let _ = tokio::time::timeout(
            Duration::from_millis(100),
            send_rpc(
                stdin.as_mut().expect("piped stdin"),
                3,
                "shutdown",
                json!(null),
            ),
        )
        .await;
    }
    drop(stdin);
    let status = if config.engine == AgentEngine::Codex && expected_success {
        tokio::time::timeout_at(deadline, child.wait())
            .await
            .ok()
            .transpose()?
    } else if config.engine == AgentEngine::Dsh && expected_success {
        tokio::time::timeout(Duration::from_millis(200), child.wait())
            .await
            .ok()
            .transpose()?
    } else {
        child.try_wait()?
    };
    if status.is_none() {
        let _ = child.start_kill();
        child.wait().await?;
    }
    drop(readers);
    if config.engine == AgentEngine::Codex && expected_success {
        match status {
            Some(status) if status.success() => state.execution.complete = true,
            Some(status) => {
                state.execution.exit_reason = format!(
                    "process_exit:{}",
                    status
                        .code()
                        .map_or_else(|| "signal".into(), |n| n.to_string())
                )
            }
            None => state.execution.exit_reason = "timeout".into(),
        }
    } else {
        state.execution.complete = expected_success;
    }
    state.execution.elapsed_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
    Ok(state.execution)
}

struct Chunk {
    stderr: bool,
    bytes: Vec<u8>,
}
fn spawn_reader<R: AsyncRead + Unpin + Send + 'static>(
    mut reader: R,
    stderr: bool,
    sender: mpsc::Sender<std::io::Result<Chunk>>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut bytes = [0u8; 4096];
        loop {
            match reader.read(&mut bytes).await {
                Ok(0) => break,
                Ok(count) => {
                    if sender
                        .send(Ok(Chunk {
                            stderr,
                            bytes: bytes[..count].to_vec(),
                        }))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                Err(error) => {
                    let _ = sender.send(Err(error)).await;
                    break;
                }
            }
        }
    })
}
struct ReaderTasks(tokio::task::JoinHandle<()>, tokio::task::JoinHandle<()>);
impl Drop for ReaderTasks {
    fn drop(&mut self) {
        self.0.abort();
        self.1.abort();
    }
}
async fn send_rpc(
    stdin: &mut ChildStdin,
    id: u64,
    method: &str,
    params: Value,
) -> anyhow::Result<()> {
    let mut bytes =
        serde_json::to_vec(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))?;
    bytes.push(b'\n');
    stdin.write_all(&bytes).await?;
    stdin.flush().await?;
    Ok(())
}
struct State {
    execution: Execution,
    pending: Vec<u8>,
    root: String,
    sessions: HashSet<String>,
    message_id: Option<String>,
    received: bool,
    done: bool,
    terminal: Option<String>,
    before_receipt: Vec<Value>,
}
impl State {
    fn new(root: String) -> Self {
        Self {
            execution: Execution {
                events: vec![],
                output: String::new(),
                exit_reason: "missing_terminal".into(),
                elapsed_ms: 0,
                input_tokens: None,
                output_tokens: None,
                complete: false,
            },
            pending: vec![],
            sessions: HashSet::from([root.clone()]),
            root,
            message_id: None,
            received: false,
            done: false,
            terminal: None,
            before_receipt: vec![],
        }
    }
    fn usage(&mut self, usage: &Value, input: &str, output: &str, caches: bool) {
        if let Some(mut count) = usage[input].as_u64() {
            if caches {
                for field in ["cacheReadTokens", "cacheWriteTokens"] {
                    count = count.saturating_add(usage[field].as_u64().unwrap_or(0));
                }
            }
            self.execution.input_tokens = Some(
                self.execution
                    .input_tokens
                    .unwrap_or(0)
                    .saturating_add(count),
            );
        }
        if let Some(count) = usage[output].as_u64() {
            self.execution.output_tokens = Some(
                self.execution
                    .output_tokens
                    .unwrap_or(0)
                    .saturating_add(count),
            );
        }
    }
    fn codex(&mut self, event: Value) {
        match event["type"].as_str() {
            Some("item.completed") if event["item"]["type"] == "agent_message" => {
                if let Some(text) = event["item"]["text"].as_str() {
                    self.execution.output = text.into();
                }
            }
            Some("turn.completed") => {
                self.usage(&event["usage"], "input_tokens", "output_tokens", false);
                self.done = true;
                self.execution.exit_reason = "completed".into();
            }
            Some("turn.failed" | "error") => {
                self.done = true;
                self.execution.exit_reason = "turn_failed".into();
            }
            _ => {}
        }
        self.execution.events.push(event);
    }
    fn dsh(&mut self, value: Value) -> anyhow::Result<bool> {
        anyhow::ensure!(value["jsonrpc"] == "2.0", "invalid JSON-RPC version");
        if let Some(id) = value["id"].as_u64() {
            self.execution.events.push(value.clone());
            anyhow::ensure!(
                value.get("error").is_none(),
                "SDK request failed: {}",
                value["error"]
            );
            if id == 1 {
                anyhow::ensure!(
                    value["result"]["serverInfo"]["name"] == "deepseek-harness-sdk-runtime",
                    "SDK identity mismatch"
                );
                return Ok(true);
            }
            if id == 2 {
                let id = value["result"]["messageId"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| anyhow::anyhow!("missing prompt messageId"))?;
                self.message_id = Some(id.into());
                for event in std::mem::take(&mut self.before_receipt) {
                    self.notification(event)?;
                }
            }
            return Ok(false);
        }
        if self.message_id.is_none() {
            self.before_receipt.push(value);
        } else {
            self.notification(value)?;
        }
        Ok(false)
    }
    fn notification(&mut self, value: Value) -> anyhow::Result<()> {
        let params = &value["params"];
        let method = value["method"].as_str().unwrap_or("");
        if method == "subagent.started" || method == "subagent.finished" {
            let parent = params["parentSessionId"].as_str().unwrap_or("");
            if !self.sessions.contains(parent) {
                return Ok(());
            }
            if method == "subagent.started" {
                let child = params["childSessionId"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| anyhow::anyhow!("missing child session id"))?;
                self.sessions.insert(child.into());
            }
            self.execution.events.push(value);
            return Ok(());
        }
        let session = params["sessionId"].as_str().unwrap_or("");
        if !self.sessions.contains(session) {
            return Ok(());
        }
        let root = session == self.root;
        if method == "session.event" {
            let event = &params["event"];
            let event_type = event["type"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("missing session event type"))?;
            if root && event_type == "agent/inbox/spliced" {
                if let Some(inserted) = event["data"]["inserted"].as_array() {
                    if inserted
                        .iter()
                        .any(|message| message["id"].as_str() == self.message_id.as_deref())
                    {
                        self.received = true;
                    }
                }
            }
            if self.received {
                if event_type == "assistant/message" {
                    let content = event["data"]["message"]["content"]
                        .as_array()
                        .ok_or_else(|| anyhow::anyhow!("malformed assistant message"))?;
                    if root {
                        self.execution.output = content
                            .iter()
                            .filter(|block| block["type"] == "text")
                            .filter_map(|block| block["text"].as_str())
                            .collect();
                    }
                    self.usage(&event["data"]["usage"], "inputTokens", "outputTokens", true);
                }
                if root && event_type == "turn/end" {
                    let reason = event["data"]["reason"]["kind"]
                        .as_str()
                        .ok_or_else(|| anyhow::anyhow!("missing turn end reason"))?;
                    self.terminal = Some(reason.into());
                }
            }
        }
        if root && method == "session.status" && params["status"] == "idle" && self.received {
            if let Some(reason) = &self.terminal {
                self.done = true;
                self.execution.exit_reason = if reason == "completed" {
                    "completed".into()
                } else {
                    format!("turn_{reason}")
                };
            }
        }
        self.execution.events.push(value);
        Ok(())
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    fn fixture(body: &str, engine: AgentEngine) -> (tempfile::TempDir, RunnerConfig) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("agent.py");
        std::fs::write(
            &path,
            format!(
                "#!/usr/bin/env python3\nimport sys,json,time,os\n{}\n",
                body
            ),
        )
        .unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        let config = RunnerConfig {
            engine,
            executable: path,
            timeout_seconds: 2,
            ..Default::default()
        };
        (dir, config)
    }

    #[test]
    fn inherited_credentials_require_safe_names_and_available_values() {
        let mut config = RunnerConfig::default();
        assert!(
            serde_json::to_value(&config)
                .unwrap()
                .get("inherited_environment")
                .is_none()
        );
        config.inherited_environment = vec!["KINIC_TEST_MISSING_CREDENTIAL_A947BC".into()];
        let error = config.inherited_values().unwrap_err().to_string();
        assert!(error.contains("required inherited environment variable is unavailable"));
        for name in [
            "HOME",
            "PATH",
            "TMPDIR",
            "CARGO_TARGET_DIR",
            "DSH_PERMISSION_MODE",
            "BAD=private-value",
        ] {
            config.inherited_environment = vec![name.into()];
            let error = config.inherited_values().unwrap_err().to_string();
            assert!(!error.contains("private-value"));
            assert!(error.contains("invalid inherited environment"));
        }
    }
    #[tokio::test]
    async fn read_only_configuration_overrides_ambient_and_extra_environment_policy() {
        let (dir, mut cfg) = fixture(
            "assert sys.argv[sys.argv.index('--sandbox')+1]=='read-only';print(json.dumps({'type':'turn.completed'}))",
            AgentEngine::Codex,
        );
        cfg.read_only = true;
        assert!(execute(&cfg, dir.path(), "x").await.unwrap().complete);
        let (dir, mut cfg) = fixture(
            "assert os.environ['DSH_PERMISSION_MODE']=='read-only';print(json.dumps({'jsonrpc':'2.0','id':1,'observed':'read-only'}))",
            AgentEngine::Dsh,
        );
        cfg.read_only = true;
        cfg.extra_args = vec!["--patch=unsafe.yml".into()];
        assert!(execute(&cfg, dir.path(), "x").await.is_err());
        cfg.extra_args.clear();
        cfg.environment
            .insert("DSH_PERMISSION_MODE".into(), "danger-full-access".into());
        let run = execute(&cfg, dir.path(), "x").await.unwrap();
        assert!(
            run.events
                .iter()
                .any(|event| event["observed"] == "read-only"),
            "{:?}",
            run.events
        );
    }
    #[tokio::test]
    async fn rejects_profile_model_and_sandbox_override_arguments() {
        for (engine, argument) in [
            (AgentEngine::Dsh, "--profile=web"),
            (AgentEngine::Dsh, "--profile"),
            (
                AgentEngine::Codex,
                "--dangerously-bypass-approvals-and-sandbox",
            ),
            (AgentEngine::Codex, "--model=other"),
            (AgentEngine::Codex, "--sandbox=danger-full-access"),
            (AgentEngine::Codex, "--config"),
        ] {
            let (dir, mut cfg) = fixture("pass", engine);
            cfg.extra_args.push(argument.into());
            assert!(execute(&cfg, dir.path(), "x").await.is_err(), "{argument}");
        }
    }
    #[tokio::test]
    async fn codex_requires_terminal_and_reads_prompt_and_usage() {
        let (dir, cfg) = fixture(
            r#"assert sys.argv[1:3] == ['exec','--json']
assert '--cd' in sys.argv and sys.argv[-1] == '-'
assert sys.stdin.read() == 'hello $() `quoted`'
print(json.dumps({'type':'item.completed','item':{'type':'agent_message','text':'answer'}}))
print(json.dumps({'type':'turn.completed','usage':{'input_tokens':11,'output_tokens':7}}))"#,
            AgentEngine::Codex,
        );
        let run = execute(&cfg, dir.path(), "hello $() `quoted`")
            .await
            .unwrap();
        assert!(run.complete, "{}", run.exit_reason);
        assert_eq!(run.output, "answer");
        assert_eq!(run.input_tokens, Some(11));
        assert_eq!(run.output_tokens, Some(7));
    }
    #[tokio::test]
    async fn codex_rejects_absent_failed_malformed_and_truncated_terminal() {
        for body in [
            "print('{}')",
            "print('{bad')",
            "sys.stdout.write('{\"type\":\"turn.completed\"}')",
            "print(json.dumps({'type':'turn.failed','error':{'message':'bad'}}))",
            "print(json.dumps({'type':'turn.completed'}));sys.exit(3)",
        ] {
            let (dir, cfg) = fixture(body, AgentEngine::Codex);
            let run = execute(&cfg, dir.path(), "x").await.unwrap();
            assert!(!run.complete, "{body}");
        }
    }
    #[tokio::test]
    async fn bounds_timeout_and_both_output_streams() {
        let (dir, mut cfg) = fixture("sys.stdin.read();time.sleep(20)", AgentEngine::Codex);
        cfg.timeout_seconds = 1;
        let run = execute(&cfg, dir.path(), "x").await.unwrap();
        assert_eq!(run.exit_reason, "timeout");
        assert!(run.elapsed_ms < 4000);
        for stream in ["stdout", "stderr"] {
            let (dir, mut cfg) = fixture(
                &format!("sys.{stream}.write('x'*100000);sys.{stream}.flush();time.sleep(20)"),
                AgentEngine::Codex,
            );
            cfg.max_output_bytes = 512;
            let run = execute(&cfg, dir.path(), "x").await.unwrap();
            assert_eq!(run.exit_reason, "output_limit");
            assert!(!run.complete);
        }
    }

    #[tokio::test]
    async fn dsh_rejects_enqueue_only_startup_idle_errors_and_missing_terminal() {
        let prefix = r#"def emit(x): print(json.dumps(x),flush=True)
i=json.loads(sys.stdin.readline())
emit({'jsonrpc':'2.0','id':i['id'],'result':{'serverInfo':{'name':'deepseek-harness-sdk-runtime','version':'x'}}})
p=json.loads(sys.stdin.readline());s=p['params']['sessionId']
emit({'jsonrpc':'2.0','id':p['id'],'result':{'messageId':'receipt'}})
"#;
        for body in [
            "emit({'jsonrpc':'2.0','method':'session.status','params':{'sessionId':s,'status':'idle'}})",
            "emit({'jsonrpc':'2.0','method':'session.event','params':{'sessionId':s,'event':{'type':'agent/inbox/spliced','data':{'inserted':[{'id':'receipt'}]}}}});emit({'jsonrpc':'2.0','method':'session.status','params':{'sessionId':s,'status':'idle'}})",
            "emit({'jsonrpc':'2.0','id':2,'error':{'code':7,'message':'failed'}})",
            "sys.stdout.write('{bad');sys.stdout.flush()",
        ] {
            let (dir, mut cfg) = fixture(&format!("{prefix}{body}"), AgentEngine::Dsh);
            cfg.timeout_seconds = 1;
            let run = execute(&cfg, dir.path(), "hello").await.unwrap();
            assert!(!run.complete, "{body}");
        }
    }
    #[tokio::test]
    async fn output_budget_cannot_be_bypassed_by_terminal_in_same_chunk() {
        let (dir, mut cfg) = fixture(
            "print(json.dumps({'type':'turn.completed','padding':'x'*4000}))",
            AgentEngine::Codex,
        );
        cfg.max_output_bytes = 100;
        let run = execute(&cfg, dir.path(), "x").await.unwrap();
        assert!(!run.complete);
        assert_eq!(run.exit_reason, "output_limit");
    }

    #[tokio::test]
    async fn dsh_combined_chunk_budget_precedes_completion() {
        let body = r#"i=json.loads(sys.stdin.readline());print(json.dumps({'jsonrpc':'2.0','id':1,'result':{'serverInfo':{'name':'deepseek-harness-sdk-runtime'}}}),flush=True)
p=json.loads(sys.stdin.readline());s=p['params']['sessionId']
lines=[{'jsonrpc':'2.0','id':2,'result':{'messageId':'m'}},{'jsonrpc':'2.0','method':'session.event','params':{'sessionId':s,'event':{'type':'agent/inbox/spliced','data':{'inserted':[{'id':'m'}]}}}},{'jsonrpc':'2.0','method':'session.event','params':{'sessionId':s,'event':{'type':'turn/end','data':{'reason':{'kind':'completed'}}}}},{'jsonrpc':'2.0','method':'session.status','params':{'sessionId':s,'status':'idle'}}]
os.write(1, ('\n'.join(json.dumps(x) for x in lines)+'\n'+'x'*3000).encode());sys.stdin.read()
"#;
        let (dir, mut cfg) = fixture(body, AgentEngine::Dsh);
        cfg.max_output_bytes = 1000;
        let run = execute(&cfg, dir.path(), "x").await.unwrap();
        assert!(!run.complete);
        assert_eq!(run.exit_reason, "output_limit");
    }
    #[tokio::test]
    async fn environment_can_be_cleared_and_prompt_never_goes_through_shell() {
        let (dir, mut cfg) = fixture(
            "assert os.environ.get('LEARNING_FIXTURE')=='set';assert 'HOME' not in os.environ;assert sys.stdin.read()=='$(touch PWNED)';print(json.dumps({'type':'turn.completed'}))",
            AgentEngine::Codex,
        );
        cfg.env_clear = true;
        cfg.environment
            .insert("PATH".into(), std::env::var("PATH").unwrap());
        cfg.environment
            .insert("LEARNING_FIXTURE".into(), "set".into());
        let run = execute(&cfg, dir.path(), "$(touch PWNED)").await.unwrap();
        assert!(run.complete, "{}", run.exit_reason);
        assert!(!dir.path().join("PWNED").exists());
    }
    #[tokio::test]
    async fn dsh_scopes_descendants_and_requires_receipt_terminal_and_idle() {
        let body = r#"assert sys.argv[1:3] == ['--profile','sdk']
def emit(x): print(json.dumps(x),flush=True)
def event(s,t,d): emit({'jsonrpc':'2.0','method':'session.event','params':{'sessionId':s,'event':{'type':t,'data':d}}})
def status(s): emit({'jsonrpc':'2.0','method':'session.status','params':{'sessionId':s,'status':'idle'}})
i=json.loads(sys.stdin.readline());assert i['method']=='initialize';assert i['params']['provider']=='deepseek';assert i['params']['model']=='deepseek-chat'
emit({'jsonrpc':'2.0','id':i['id'],'result':{'serverInfo':{'name':'deepseek-harness-sdk-runtime','version':'x'}}})
p=json.loads(sys.stdin.readline());s=p['params']['sessionId'];assert p['params']['contentBlocks']==[{'type':'text','text':'hello'}]
status(s)
event('unrelated','turn/end',{'reason':{'kind':'completed'}})
emit({'jsonrpc':'2.0','id':p['id'],'result':{'messageId':'receipt'}})
status(s)
event(s,'agent/inbox/spliced',{'inserted':[{'id':'receipt'}]})
emit({'jsonrpc':'2.0','method':'subagent.started','params':{'parentSessionId':s,'childSessionId':'child'}})
event('child','assistant/message',{'message':{'content':[{'type':'text','text':'child'}]},'usage':{'inputTokens':2,'cacheReadTokens':3,'outputTokens':4}})
event('unrelated','assistant/message',{'message':{'content':[{'type':'text','text':'WRONG'}]},'usage':{'inputTokens':999,'outputTokens':999}})
event(s,'assistant/message',{'message':{'content':[{'type':'text','text':'answer'}]},'usage':{'inputTokens':5,'outputTokens':6}})
event(s,'turn/end',{'reason':{'kind':'completed'}})
status(s)
sys.stdin.read()
"#;
        let (dir, mut cfg) = fixture(body, AgentEngine::Dsh);
        cfg.model = Some("deepseek-chat".into());
        let run = execute(&cfg, dir.path(), "hello").await.unwrap();
        assert!(run.complete, "{}", run.exit_reason);
        assert_eq!(run.output, "answer");
        assert_eq!(run.input_tokens, Some(10));
        assert_eq!(run.output_tokens, Some(10));
        assert!(
            run.events
                .iter()
                .any(|e| e["params"]["sessionId"] == "child")
        );
        assert!(
            !run.events
                .iter()
                .any(|e| e["params"]["sessionId"] == "unrelated")
        );
    }
}
