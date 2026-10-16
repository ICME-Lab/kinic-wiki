//! Reproducible, isolated four-mode evaluation of externally prepared knowledge.

use crate::learning_runner::{self, Execution, RunnerConfig};
use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Component, Path, PathBuf},
    process::Stdio,
};
use tokio::{io::AsyncReadExt, process::Command};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvaluationMode {
    None,
    Raw,
    Current,
    Revision,
}
impl EvaluationMode {
    pub const ALL: [Self; 4] = [Self::None, Self::Raw, Self::Current, Self::Revision];
    fn label(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Raw => "raw",
            Self::Current => "current",
            Self::Revision => "revision",
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskSplit {
    Train,
    Validation,
    Final,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SuiteManifest {
    pub suite_id: String,
    pub tasks: Vec<EvaluationTask>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvaluationTask {
    pub id: String,
    pub family: String,
    pub split: TaskSplit,
    pub repo: PathBuf,
    pub start_commit: String,
    pub prompt: String,
    /// Each check is an executable and argv; no command string is interpreted by a shell.
    pub verification: Vec<Vec<String>>,
    pub allowed_paths: Vec<String>,
    #[serde(default)]
    pub environment: EnvironmentConstraints,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct EnvironmentConstraints {
    pub os: Option<String>,
    pub arch: Option<String>,
    pub variables: BTreeMap<String, String>,
    pub required_programs: Vec<String>,
    pub verification_timeout_seconds: u64,
}
impl Default for EnvironmentConstraints {
    fn default() -> Self {
        Self {
            os: None,
            arch: None,
            variables: BTreeMap::new(),
            required_programs: vec![],
            verification_timeout_seconds: 300,
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreparedContext {
    pub snapshot_id: String,
    pub content: String,
}
pub type PreparedContexts = BTreeMap<String, BTreeMap<EvaluationMode, PreparedContext>>;
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VerificationResult {
    pub argv: Vec<String>,
    pub passed: bool,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    pub output_truncated: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvaluationSample {
    pub task_id: String,
    pub family: String,
    pub split: TaskSplit,
    pub trial: u32,
    pub mode: EvaluationMode,
    pub snapshot_id: String,
    pub context_hash: String,
    pub workspace: PathBuf,
    pub source_tree: String,
    pub environment_fingerprint: String,
    pub execution: Option<Execution>,
    pub checks: Vec<VerificationResult>,
    pub changed_paths: Vec<String>,
    pub outside_scope: Vec<String>,
    pub success: bool,
    pub error: Option<String>,
    pub cost_usd: Option<f64>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvaluationReport {
    pub schema_version: u32,
    pub trials: u32,
    pub redacted: bool,
    pub suite_id: String,
    pub suite_fingerprint: String,
    pub manifest: SuiteManifest,
    pub config_fingerprint: String,
    pub runner: RunnerConfig,
    pub host_os: String,
    pub host_arch: String,
    pub created_at: String,
    pub samples: Vec<EvaluationSample>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FamilyComparison {
    pub family: String,
    pub pairs: usize,
    pub baseline_success: usize,
    pub candidate_success: usize,
    pub delta: f64,
    pub regression: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Comparison {
    pub eligible: bool,
    pub reasons: Vec<String>,
    pub split: TaskSplit,
    pub baseline_mode: EvaluationMode,
    pub candidate_mode: EvaluationMode,
    pub config_fingerprint: String,
    pub baseline_snapshot_ids: Vec<String>,
    pub candidate_snapshot_ids: Vec<String>,
    pub paired_samples: usize,
    pub independent_families: usize,
    pub mean_delta: f64,
    pub lower_bound: f64,
    pub upper_bound: f64,
    pub confidence_level: f64,
    pub bootstrap_seed: u64,
    pub bootstrap_replicates: usize,
    pub per_family: Vec<FamilyComparison>,
}

fn secret_key(key: &str) -> bool {
    let upper = key.to_ascii_uppercase();
    ["TOKEN", "KEY", "SECRET", "PASSWORD", "CREDENTIAL", "AUTH"]
        .iter()
        .any(|part| upper.contains(part))
}
fn secret_values(runner: &RunnerConfig) -> Vec<String> {
    runner
        .environment
        .iter()
        .filter(|(key, value)| secret_key(key) && !value.is_empty())
        .map(|(_, value)| value.clone())
        .collect()
}
fn redact_value(value: &mut serde_json::Value, secrets: &[String]) {
    match value {
        serde_json::Value::String(text) => {
            for secret in secrets {
                *text = text.replace(secret, "[REDACTED]");
            }
        }
        serde_json::Value::Array(values) => {
            for value in values {
                redact_value(value, secrets);
            }
        }
        serde_json::Value::Object(values) => {
            for value in values.values_mut() {
                redact_value(value, secrets);
            }
        }
        _ => {}
    }
}
fn write_redacted_json<T: Serialize>(path: &Path, value: &T, secrets: &[String]) -> Result<()> {
    let mut value = serde_json::to_value(value)?;
    redact_value(&mut value, secrets);
    write_json_atomic(path, &value)
}

fn digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}
fn fingerprint<T: Serialize>(value: &T) -> Result<String> {
    Ok(digest(&serde_json::to_vec(value)?))
}
fn safe_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}
fn validate_allowed_path(value: &str) -> Result<()> {
    ensure!(!value.is_empty(), "empty allowed path");
    let path = Path::new(value);
    ensure!(
        path.components().all(|c| matches!(c, Component::Normal(_))),
        "allowed paths must be relative normal paths: {value}"
    );
    ensure!(!path.starts_with(".git"), "git internals cannot be allowed");
    Ok(())
}
fn path_is_allowed(path: &str, allowed: &[String]) -> bool {
    allowed
        .iter()
        .any(|prefix| Path::new(path).starts_with(prefix))
}
impl SuiteManifest {
    /// Resolve repository paths and the explicit external-verifier placeholder against
    /// the manifest directory before evaluation. This never copies verifier files.
    pub fn resolve_paths(&mut self, manifest_directory: &Path) -> Result<()> {
        let base = std::fs::canonicalize(manifest_directory)?;
        for task in &mut self.tasks {
            if task.repo.is_relative() {
                task.repo = base.join(&task.repo);
            }
            task.repo = std::fs::canonicalize(&task.repo)?;
            for argv in &mut task.verification {
                for arg in argv {
                    *arg = arg.replace("{suite_dir}", &base.to_string_lossy());
                }
            }
        }
        Ok(())
    }
    pub fn validate(&self) -> Result<()> {
        ensure!(safe_id(&self.suite_id), "invalid suite id");
        ensure!(!self.tasks.is_empty(), "suite has no tasks");
        let mut ids = BTreeSet::new();
        let mut family_splits = BTreeMap::new();
        for task in &self.tasks {
            ensure!(
                safe_id(&task.id) && safe_id(&task.family),
                "invalid task or family id"
            );
            ensure!(ids.insert(&task.id), "duplicate task id: {}", task.id);
            if let Some(previous) = family_splits.insert(&task.family, task.split) {
                ensure!(
                    previous == task.split,
                    "family {} crosses train/validation/final split",
                    task.family
                );
            }
            ensure!(
                [40, 64].contains(&task.start_commit.len())
                    && task.start_commit.bytes().all(|b| b.is_ascii_hexdigit()),
                "start_commit must be an immutable full commit hash"
            );
            ensure!(!task.prompt.trim().is_empty(), "task prompt is empty");
            ensure!(
                !task.verification.is_empty(),
                "task {} has no verification",
                task.id
            );
            for argv in &task.verification {
                ensure!(
                    !argv.is_empty() && !argv[0].is_empty(),
                    "verification requires executable argv"
                );
            }
            ensure!(
                !task.allowed_paths.is_empty(),
                "task {} has no allowed paths",
                task.id
            );
            for path in &task.allowed_paths {
                validate_allowed_path(path)?;
            }
            ensure!(
                !task.environment.variables.keys().any(|key| secret_key(key)),
                "credentials belong in explicit runner environment, not task manifests"
            );
            ensure!(
                task.environment.verification_timeout_seconds > 0,
                "verification timeout must be positive"
            );
            if let Some(os) = &task.environment.os {
                ensure!(os == std::env::consts::OS, "task requires OS {os}");
            }
            if let Some(arch) = &task.environment.arch {
                ensure!(
                    arch == std::env::consts::ARCH,
                    "task requires architecture {arch}"
                );
            }
        }
        Ok(())
    }
}

/// A fresh source archive is exported for every task/trial/mode. Knowledge is supplied
/// explicitly: this API never retrieves from, mutates, or flushes the live knowledge store.
pub async fn evaluate_suite(
    manifest: &SuiteManifest,
    runner: &RunnerConfig,
    contexts: &PreparedContexts,
    output: &Path,
    trials: u32,
) -> Result<EvaluationReport> {
    manifest.validate()?;
    ensure!(trials > 0, "trials must be positive");
    for task in &manifest.tasks {
        let prepared = contexts
            .get(&task.id)
            .with_context(|| format!("missing prepared contexts for {}", task.id))?;
        for mode in EvaluationMode::ALL {
            let context = prepared
                .get(&mode)
                .with_context(|| format!("missing {} context for {}", mode.label(), task.id))?;
            ensure!(
                !context.snapshot_id.is_empty(),
                "snapshot identity must be explicit"
            );
            if mode == EvaluationMode::None {
                ensure!(
                    context.content.is_empty(),
                    "none mode must supply no knowledge"
                );
            }
        }
    }
    // Prevent accidental reuse/overwrite of another evaluation workspace.
    std::fs::create_dir(output).context("evaluation output must be a new directory")?;
    let output = std::fs::canonicalize(output)?;
    ensure!(
        !output.starts_with("/private/tmp"),
        "evaluation workspaces cannot be under /private/tmp"
    );
    let mut secrets = secret_values(runner);
    secrets.extend(runner.inherited_values()?.into_values());
    let mut reported_runner = runner.clone();
    for (key, value) in &mut reported_runner.environment {
        if secret_key(key) {
            *value = "[REDACTED]".into();
        }
    }
    let mut reported_manifest = serde_json::to_value(manifest)?;
    redact_value(&mut reported_manifest, &secrets);
    let reported_manifest: SuiteManifest = serde_json::from_value(reported_manifest)?;
    let mut report = EvaluationReport {
        schema_version: 1,
        trials,
        redacted: true,
        suite_id: manifest.suite_id.clone(),
        suite_fingerprint: fingerprint(&reported_manifest)?,
        manifest: reported_manifest,
        config_fingerprint: fingerprint(runner)?,
        runner: reported_runner,
        host_os: std::env::consts::OS.into(),
        host_arch: std::env::consts::ARCH.into(),
        created_at: chrono::Utc::now().to_rfc3339(),
        samples: vec![],
    };
    write_redacted_json(&output.join("manifest.json"), manifest, &secrets)?;
    write_redacted_json(&output.join("contexts.json"), contexts, &secrets)?;
    for task in &manifest.tasks {
        for trial in 0..trials {
            for mode in EvaluationMode::ALL {
                let context = &contexts[&task.id][&mode];
                let directory = output.join(format!("{}-{}-{}", task.id, trial, mode.label()));
                let sample = evaluate_one(task, runner, context, mode, trial, &directory).await?;
                report.samples.push(sample);
                write_json_atomic(&output.join("report.json"), &report)?;
            }
        }
    }
    validate_report(&report)?;
    Ok(report)
}
fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let tmp = path.with_extension("json.pending");
    std::fs::write(&tmp, serde_json::to_vec_pretty(value)?)?;
    std::fs::rename(tmp, path)?;
    Ok(())
}
async fn git(repo: &Path, args: &[&str]) -> Result<String> {
    let result = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .output()
        .await?;
    ensure!(
        result.status.success(),
        "git failed: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    Ok(String::from_utf8(result.stdout)?.trim().to_string())
}
async fn export_workspace(task: &EvaluationTask, directory: &Path) -> Result<(PathBuf, String)> {
    std::fs::create_dir(directory)?;
    let workspace = directory.join("workspace");
    std::fs::create_dir(&workspace)?;
    let tree = git(
        &task.repo,
        &["rev-parse", &format!("{}^{{tree}}", task.start_commit)],
    )
    .await?;
    let archive = directory.join("source.tar");
    git(
        &task.repo,
        &[
            "archive",
            "--format=tar",
            "--output",
            archive.to_str().context("non UTF-8 archive path")?,
            &task.start_commit,
        ],
    )
    .await?;
    let status = Command::new("tar")
        .arg("-xf")
        .arg(&archive)
        .arg("-C")
        .arg(&workspace)
        .status()
        .await?;
    ensure!(status.success(), "source archive extraction failed");
    std::fs::remove_file(archive)?;
    // Source history, remotes, host worktree changes and git hooks are never copied.
    git(
        &workspace,
        &["-c", "core.hooksPath=/dev/null", "init", "--quiet"],
    )
    .await?;
    git(&workspace, &["add", "--force", "--all"]).await?;
    git(
        &workspace,
        &[
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "user.name=Evaluation",
            "-c",
            "user.email=evaluation@invalid",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "--quiet",
            "--allow-empty",
            "-m",
            "Evaluation source baseline",
        ],
    )
    .await?;
    Ok((workspace, tree))
}
fn prepared_environment(
    task: &EvaluationTask,
    directory: &Path,
    runner: &RunnerConfig,
) -> Result<BTreeMap<String, String>> {
    let mut environment: BTreeMap<String, String> = runner
        .environment
        .iter()
        .filter(|(key, _)| !secret_key(key) && !runner.inherited_environment.contains(key))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    environment.extend(task.environment.variables.clone());
    if !environment.contains_key("PATH") {
        environment.insert(
            "PATH".into(),
            runner
                .environment
                .get("PATH")
                .cloned()
                .or_else(|| std::env::var("PATH").ok())
                .unwrap_or_else(|| "/usr/bin:/bin".into()),
        );
    }
    for (key, folder) in [("HOME", "home"), ("TMPDIR", "tmp")] {
        let path = directory.join(folder);
        std::fs::create_dir(&path)?;
        environment.insert(key.into(), path.to_string_lossy().into_owned());
    }
    environment
        .entry("CARGO_TARGET_DIR".into())
        .or_insert_with(|| {
            directory
                .join("cargo-target")
                .to_string_lossy()
                .into_owned()
        });
    environment
        .entry("PYTHONDONTWRITEBYTECODE".into())
        .or_insert_with(|| "1".into());
    for program in &task.environment.required_programs {
        let found = if Path::new(program).is_absolute() {
            Path::new(program).is_file()
        } else {
            std::env::split_paths(std::ffi::OsStr::new(&environment["PATH"]))
                .any(|directory| directory.join(program).is_file())
        };
        ensure!(found, "required program is unavailable: {program}");
    }
    Ok(environment)
}
fn file_digest(path: &Path) -> Result<String> {
    use std::io::Read;
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}
fn runtime_fingerprint(
    environment: &BTreeMap<String, String>,
    task: &EvaluationTask,
    runner: &RunnerConfig,
    directory: &Path,
) -> Result<String> {
    let mut identity: BTreeMap<String, String> = environment
        .iter()
        .map(|(key, value)| {
            (
                key.clone(),
                value.replace(&*directory.to_string_lossy(), "{evaluation_directory}"),
            )
        })
        .collect();
    identity.insert("@os".into(), std::env::consts::OS.into());
    identity.insert("@arch".into(), std::env::consts::ARCH.into());
    let resolve = |program: &str| -> Option<PathBuf> {
        let path = Path::new(program);
        if path.is_absolute() {
            return path.is_file().then(|| path.to_path_buf());
        }
        std::env::split_paths(std::ffi::OsStr::new(&environment["PATH"]))
            .map(|folder| folder.join(program))
            .find(|path| path.is_file())
    };
    let mut programs = task.environment.required_programs.clone();
    programs.push(runner.executable.to_string_lossy().into_owned());
    programs.extend(task.verification.iter().map(|argv| argv[0].clone()));
    for program in programs {
        if let Some(path) = resolve(&program) {
            identity.insert(format!("@program:{program}"), file_digest(&path)?);
        }
    }
    // Fingerprint explicitly referenced external oracle/input files as well as tools.
    // Workspace-relative files are already covered by the pinned source tree.
    for argv in &task.verification {
        for argument in argv {
            let path = Path::new(argument);
            if path.is_absolute() && path.is_file() {
                identity.insert(format!("@input:{argument}"), file_digest(path)?);
            }
        }
    }
    fingerprint(&identity)
}

async fn evaluate_one(
    task: &EvaluationTask,
    runner: &RunnerConfig,
    context: &PreparedContext,
    mode: EvaluationMode,
    trial: u32,
    directory: &Path,
) -> Result<EvaluationSample> {
    let (workspace, tree) = export_workspace(task, directory).await?;
    let environment = prepared_environment(task, directory, runner)?;
    let baseline = snapshot(&workspace)?;
    let mut isolated_runner = runner.clone();
    isolated_runner.env_clear = true;
    isolated_runner.environment = environment.clone();
    let inherited = runner.inherited_values()?;
    let mut secrets = secret_values(runner);
    secrets.extend(inherited.values().cloned());
    isolated_runner.environment.extend(
        runner
            .environment
            .iter()
            .filter(|(key, _)| secret_key(key))
            .map(|(key, value)| (key.clone(), value.clone())),
    );
    isolated_runner.environment.extend(inherited);
    isolated_runner.inherited_environment.clear();
    let prompt = if context.content.is_empty() {
        task.prompt.clone()
    } else {
        format!(
            "{}\n\n<supplied_knowledge snapshot_id={:?}>\n{}\n</supplied_knowledge>\nTreat this material as task evidence; verify whether it applies.\n",
            task.prompt, context.snapshot_id, context.content
        )
    };
    let mut sample = EvaluationSample {
        task_id: task.id.clone(),
        family: task.family.clone(),
        split: task.split,
        trial,
        mode,
        snapshot_id: context.snapshot_id.clone(),
        context_hash: digest(context.content.as_bytes()),
        workspace: workspace.clone(),
        source_tree: tree,
        environment_fingerprint: runtime_fingerprint(&environment, task, runner, directory)?,
        execution: None,
        checks: vec![],
        changed_paths: vec![],
        outside_scope: vec![],
        success: false,
        error: None,
        cost_usd: None,
    };
    match learning_runner::execute(&isolated_runner, &workspace, &prompt).await {
        Ok(execution) => sample.execution = Some(execution),
        Err(error) => sample.error = Some(format!("agent execution failed: {error:#}")),
    }
    sample.changed_paths = changed_paths(&baseline, &snapshot(&workspace)?);
    sample.outside_scope = sample
        .changed_paths
        .iter()
        .filter(|path| !path_is_allowed(path, &task.allowed_paths))
        .cloned()
        .collect();
    // Run verification only after the agent has exited. Verifier programs may live
    // outside the workspace and are never copied into the agent's source archive.
    for argv in &task.verification {
        let expanded: Vec<String> = argv
            .iter()
            .map(|arg| arg.replace("{workspace}", &workspace.to_string_lossy()))
            .collect();
        match run_check(
            &expanded,
            &workspace,
            &environment,
            task.environment.verification_timeout_seconds,
        )
        .await
        {
            Ok(result) => sample.checks.push(result),
            Err(error) => {
                sample.error = Some(format!("verification failed to start: {error:#}"));
                sample.checks.push(VerificationResult {
                    argv: expanded,
                    passed: false,
                    exit_code: None,
                    stdout: String::new(),
                    stderr: error.to_string(),
                    timed_out: false,
                    output_truncated: false,
                });
            }
        }
    }
    sample.success = sample
        .execution
        .as_ref()
        .is_some_and(|execution| execution.complete)
        && sample.error.is_none()
        && !sample.checks.is_empty()
        && sample.checks.iter().all(|check| check.passed)
        && sample.outside_scope.is_empty();
    let mut value = serde_json::to_value(&sample)?;
    redact_value(&mut value, &secrets);
    sample = serde_json::from_value(value)?;
    write_json_atomic(&directory.join("sample.json"), &sample)?;
    Ok(sample)
}
async fn run_check(
    argv: &[String],
    cwd: &Path,
    environment: &BTreeMap<String, String>,
    seconds: u64,
) -> Result<VerificationResult> {
    ensure!(!argv.is_empty(), "empty verification argv");
    let mut child = Command::new(&argv[0])
        .args(&argv[1..])
        .current_dir(cwd)
        .env_clear()
        .envs(environment)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
    let stdout = child.stdout.take().context("missing stdout")?;
    let stderr = child.stderr.take().context("missing stderr")?;
    const LIMIT: u64 = 1_048_576;
    let mut out = vec![];
    let mut err = vec![];
    let execution = async {
        let mut stdout = stdout.take(LIMIT + 1);
        let mut stderr = stderr.take(LIMIT + 1);
        let (out_read, err_read, status) = tokio::join!(
            stdout.read_to_end(&mut out),
            stderr.read_to_end(&mut err),
            child.wait()
        );
        out_read?;
        err_read?;
        Result::<_>::Ok(status?)
    };
    let status = tokio::time::timeout(std::time::Duration::from_secs(seconds), execution).await;
    let (exit_code, timed_out) = match status {
        Ok(result) => (result?.code(), false),
        Err(_) => {
            let _ = child.kill().await;
            (None, true)
        }
    };
    let output_truncated = out.len() as u64 > LIMIT || err.len() as u64 > LIMIT;
    out.truncate(LIMIT as usize);
    err.truncate(LIMIT as usize);
    Ok(VerificationResult {
        argv: argv.to_vec(),
        passed: exit_code == Some(0) && !timed_out && !output_truncated,
        exit_code,
        stdout: String::from_utf8_lossy(&out).into_owned(),
        stderr: String::from_utf8_lossy(&err).into_owned(),
        timed_out,
        output_truncated,
    })
}
fn snapshot(root: &Path) -> Result<BTreeMap<String, String>> {
    fn walk(root: &Path, directory: &Path, files: &mut BTreeMap<String, String>) -> Result<()> {
        for entry in std::fs::read_dir(directory)? {
            let entry = entry?;
            let path = entry.path();
            let relative = path.strip_prefix(root)?;
            if relative.starts_with(".git") {
                continue;
            }
            let kind = entry.file_type()?;
            let key = relative
                .to_str()
                .context("non UTF-8 workspace path")?
                .to_owned();
            if kind.is_symlink() {
                files.insert(
                    key,
                    format!("symlink:{}", std::fs::read_link(&path)?.to_string_lossy()),
                );
            } else if kind.is_dir() {
                walk(root, &path, files)?;
            } else if kind.is_file() {
                use std::io::Read;
                let mut file = std::fs::File::open(&path)?;
                let mut hasher = Sha256::new();
                let mut buffer = [0u8; 65536];
                loop {
                    let n = file.read(&mut buffer)?;
                    if n == 0 {
                        break;
                    }
                    hasher.update(&buffer[..n]);
                }
                #[cfg(unix)]
                let mode = {
                    use std::os::unix::fs::PermissionsExt;
                    entry.metadata()?.permissions().mode() & 0o777
                };
                #[cfg(not(unix))]
                let mode = 0u32;
                files.insert(
                    key,
                    format!("file:{mode:o}:{}", hex::encode(hasher.finalize())),
                );
            } else {
                bail!("unsupported special file in workspace: {}", path.display());
            }
        }
        Ok(())
    }
    let mut files = BTreeMap::new();
    walk(root, root, &mut files)?;
    Ok(files)
}
fn changed_paths(
    before: &BTreeMap<String, String>,
    after: &BTreeMap<String, String>,
) -> Vec<String> {
    before
        .keys()
        .chain(after.keys())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .filter(|key| before.get(*key) != after.get(*key))
        .cloned()
        .collect()
}

fn sample_success(sample: &EvaluationSample) -> bool {
    sample.error.is_none()
        && sample
            .execution
            .as_ref()
            .is_some_and(|execution| execution.complete && execution.exit_reason == "completed")
        && !sample.checks.is_empty()
        && sample.checks.iter().all(|check| {
            check.passed
                && check.exit_code == Some(0)
                && !check.timed_out
                && !check.output_truncated
        })
        && sample.outside_scope.is_empty()
}
/// Validate persisted evidence before any comparison. Summary booleans are never
/// accepted independently of their exit status, lifecycle, task contract and scope.
pub fn validate_report(report: &EvaluationReport) -> Result<()> {
    ensure!(
        report.schema_version == 1,
        "unsupported evaluation report schema"
    );
    ensure!(
        report.suite_id == report.manifest.suite_id,
        "report suite identity differs from manifest"
    );
    ensure!(
        fingerprint(&report.manifest)? == report.suite_fingerprint,
        "report manifest fingerprint mismatch"
    );
    let tasks: BTreeMap<_, _> = report
        .manifest
        .tasks
        .iter()
        .map(|task| (&task.id, task))
        .collect();
    ensure!(
        tasks.len() == report.manifest.tasks.len(),
        "duplicate manifest task"
    );
    ensure!(report.trials > 0, "report trial count must be positive");
    let expected_samples = tasks
        .len()
        .checked_mul(report.trials as usize)
        .and_then(|count| count.checked_mul(EvaluationMode::ALL.len()))
        .context("evaluation sample count overflow")?;
    ensure!(
        report.samples.len() == expected_samples,
        "incomplete evaluation report: expected {expected_samples} samples, received {}",
        report.samples.len()
    );
    let mut seen = BTreeSet::new();
    let mut knowledge = BTreeMap::new();
    let mut environments = BTreeMap::new();
    let mut family_splits = BTreeMap::new();
    let mut source_trees = BTreeMap::new();
    for task in &report.manifest.tasks {
        if let Some(previous) = family_splits.insert(&task.family, task.split) {
            ensure!(previous == task.split, "report family crosses split");
        }
        for path in &task.allowed_paths {
            validate_allowed_path(path)?;
        }
    }
    for sample in &report.samples {
        let task = tasks
            .get(&sample.task_id)
            .context("sample refers to unknown manifest task")?;
        ensure!(
            sample.trial < report.trials,
            "sample trial exceeds configured count"
        );
        if let Some(previous) = knowledge.insert(
            (&sample.task_id, sample.mode),
            (&sample.snapshot_id, &sample.context_hash),
        ) {
            ensure!(
                previous == (&sample.snapshot_id, &sample.context_hash),
                "mode knowledge changed between trials"
            );
        }
        if let Some(previous) =
            environments.insert(&sample.task_id, &sample.environment_fingerprint)
        {
            ensure!(
                previous == &sample.environment_fingerprint,
                "task environment changed across modes/trials"
            );
        }
        if sample.mode == EvaluationMode::None {
            ensure!(
                sample.context_hash == digest(b""),
                "none mode contains knowledge"
            );
        }
        ensure!(
            sample.family == task.family && sample.split == task.split,
            "sample family or split differs from task"
        );
        ensure!(
            seen.insert((&sample.task_id, sample.trial, sample.mode)),
            "duplicate task/trial/mode sample"
        );
        ensure!(
            !sample.snapshot_id.is_empty()
                && !sample.context_hash.is_empty()
                && !sample.source_tree.is_empty()
                && !sample.environment_fingerprint.is_empty(),
            "sample identity is incomplete"
        );
        if let Some(previous) = source_trees.insert(&sample.task_id, &sample.source_tree) {
            ensure!(
                previous == &sample.source_tree,
                "task source tree changed across samples"
            );
        }
        ensure!(
            sample.checks.len() == task.verification.len() && !sample.checks.is_empty(),
            "sample verification count differs from task"
        );
        for (check, expected) in sample.checks.iter().zip(&task.verification) {
            let expected: Vec<_> = expected
                .iter()
                .map(|arg| arg.replace("{workspace}", &sample.workspace.to_string_lossy()))
                .collect();
            ensure!(
                check.argv == expected,
                "sample verifier argv differs from task"
            );
            let passed = check.exit_code == Some(0) && !check.timed_out && !check.output_truncated;
            ensure!(
                check.passed == passed,
                "inconsistent verification success flag"
            );
        }
        if let Some(execution) = &sample.execution {
            ensure!(
                !execution.complete || execution.exit_reason == "completed",
                "inconsistent execution lifecycle"
            );
        }
        let outside: Vec<_> = sample
            .changed_paths
            .iter()
            .filter(|path| !path_is_allowed(path, &task.allowed_paths))
            .cloned()
            .collect();
        ensure!(
            outside == sample.outside_scope,
            "inconsistent scope evidence"
        );
        ensure!(
            sample.success == sample_success(sample),
            "inconsistent sample success flag"
        );
        ensure!(
            sample
                .cost_usd
                .is_none_or(|cost| cost.is_finite() && cost >= 0.0),
            "invalid recorded cost"
        );
    }
    Ok(())
}

/// Compare the previous current knowledge against the candidate revision. Eligibility
/// is always based on held-out validation families; final results never train a revision.
pub fn compare_reports(
    baseline: &EvaluationReport,
    candidate: &EvaluationReport,
) -> Result<Comparison> {
    compare_selected(
        baseline,
        candidate,
        EvaluationMode::Current,
        EvaluationMode::Revision,
        TaskSplit::Validation,
    )
}
pub fn compare_modes(
    report: &EvaluationReport,
    baseline: EvaluationMode,
    candidate: EvaluationMode,
    split: TaskSplit,
) -> Result<Comparison> {
    compare_selected(report, report, baseline, candidate, split)
}
fn compare_selected(
    before: &EvaluationReport,
    after: &EvaluationReport,
    baseline_mode: EvaluationMode,
    candidate_mode: EvaluationMode,
    split: TaskSplit,
) -> Result<Comparison> {
    validate_report(before)?;
    validate_report(after)?;
    ensure!(
        before.suite_fingerprint == after.suite_fingerprint,
        "comparison suites differ"
    );
    ensure!(
        before.config_fingerprint == after.config_fingerprint,
        "comparison runtime settings differ"
    );
    ensure!(
        before.host_os == after.host_os && before.host_arch == after.host_arch,
        "comparison host platforms differ"
    );
    ensure!(
        baseline_mode != candidate_mode,
        "comparison requires distinct modes"
    );
    type Key = (String, u32);
    let select = |report: &EvaluationReport, mode| -> Result<BTreeMap<Key, EvaluationSample>> {
        let mut result = BTreeMap::new();
        for sample in report
            .samples
            .iter()
            .filter(|sample| sample.mode == mode && sample.split == split)
        {
            ensure!(
                result
                    .insert((sample.task_id.clone(), sample.trial), sample.clone())
                    .is_none(),
                "duplicate task/trial sample"
            );
        }
        Ok(result)
    };
    let baseline = select(before, baseline_mode)?;
    let candidate = select(after, candidate_mode)?;
    ensure!(
        baseline.keys().eq(candidate.keys()),
        "comparison requires exactly matched task/trial pairs"
    );
    let mut families: BTreeMap<String, Vec<(bool, bool)>> = BTreeMap::new();
    let mut snapshot_ids = BTreeSet::new();
    let mut baseline_snapshot_ids = BTreeSet::new();
    let mut snapshots_per_task = BTreeMap::new();
    for (key, a) in &baseline {
        let b = &candidate[key];
        ensure!(
            a.family == b.family && a.source_tree == b.source_tree,
            "paired task source or family differs"
        );
        ensure!(
            a.environment_fingerprint == b.environment_fingerprint,
            "paired task environments differ"
        );
        // HOME/TMPDIR are task-local and necessarily differ; the declared environment
        // and runner settings are covered by suite/config fingerprints.
        families
            .entry(a.family.clone())
            .or_default()
            .push((sample_success(a), sample_success(b)));
        snapshot_ids.insert(b.snapshot_id.clone());
        baseline_snapshot_ids.insert(a.snapshot_id.clone());
        if let Some(previous) =
            snapshots_per_task.insert(&b.task_id, (&b.snapshot_id, &b.context_hash))
        {
            ensure!(
                previous == (&b.snapshot_id, &b.context_hash),
                "candidate context changed between trials"
            );
        }
    }
    let per_family: Vec<_> = families
        .iter()
        .map(|(family, pairs)| {
            let baseline_success = pairs.iter().filter(|(a, _)| *a).count();
            let candidate_success = pairs.iter().filter(|(_, b)| *b).count();
            FamilyComparison {
                family: family.clone(),
                pairs: pairs.len(),
                baseline_success,
                candidate_success,
                delta: (candidate_success as f64 - baseline_success as f64) / pairs.len() as f64,
                regression: candidate_success < baseline_success,
            }
        })
        .collect();
    let clusters: Vec<Vec<f64>> = families
        .values()
        .map(|pairs| {
            pairs
                .iter()
                .map(|(a, b)| f64::from(u8::from(*b)) - f64::from(u8::from(*a)))
                .collect()
        })
        .collect();
    let mean_delta = if per_family.is_empty() {
        0.0
    } else {
        per_family.iter().map(|family| family.delta).sum::<f64>() / per_family.len() as f64
    };
    const SEED: u64 = 0x4b494e49435f4556;
    let (lower_bound, upper_bound) = cluster_interval(&clusters, SEED);
    let mut reasons = vec![];
    if split != TaskSplit::Validation {
        reasons.push("only held-out validation evidence can authorize promotion".into());
    }
    if families.len() < 3 || baseline.len() < 6 {
        reasons.push("insufficient evidence: require at least three independent families and six paired trials".into());
    }
    if lower_bound <= 0.0 {
        reasons.push(
            "family-cluster 95% confidence interval does not show a positive improvement".into(),
        );
    }
    if per_family.iter().any(|family| family.regression) {
        reasons.push("one or more task families regressed".into());
    }
    Ok(Comparison {
        eligible: reasons.is_empty(),
        reasons,
        split,
        baseline_mode,
        candidate_mode,
        config_fingerprint: after.config_fingerprint.clone(),
        baseline_snapshot_ids: baseline_snapshot_ids.into_iter().collect(),
        candidate_snapshot_ids: snapshot_ids.into_iter().collect(),
        paired_samples: baseline.len(),
        independent_families: families.len(),
        mean_delta,
        lower_bound,
        upper_bound,
        confidence_level: 0.95,
        bootstrap_seed: SEED,
        bootstrap_replicates: 10_000,
        per_family,
    })
}
fn cluster_interval(clusters: &[Vec<f64>], seed: u64) -> (f64, f64) {
    if clusters.is_empty() {
        return (-1.0, 1.0);
    }
    let means: Vec<f64> = clusters
        .iter()
        .map(|cluster| cluster.iter().sum::<f64>() / cluster.len() as f64)
        .collect();
    let mut state = seed;
    let mut samples = Vec::with_capacity(10_000);
    for _ in 0..10_000 {
        let mut sum = 0.0;
        for _ in 0..means.len() {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            sum += means[state as usize % means.len()];
        }
        samples.push(sum / means.len() as f64);
    }
    samples.sort_by(f64::total_cmp);
    (samples[249], samples[9749])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_must_be_relative_and_scope_uses_components() {
        assert!(validate_allowed_path("src").is_ok());
        for path in ["", "/etc", "../src", "src/../secret", ".git", ".git/config"] {
            assert!(validate_allowed_path(path).is_err(), "accepted {path}");
        }
        assert!(path_is_allowed("src/main.rs", &["src".into()]));
        assert!(!path_is_allowed("src-secret", &["src".into()]));
    }

    #[test]
    fn snapshot_detects_ignored_and_deleted_files_without_trusting_git() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("src")).unwrap();
        std::fs::write(root.path().join("src/main.rs"), "old").unwrap();
        let before = snapshot(root.path()).unwrap();
        std::fs::remove_file(root.path().join("src/main.rs")).unwrap();
        std::fs::write(root.path().join("secret"), "new").unwrap();
        let changed = changed_paths(&before, &snapshot(root.path()).unwrap());
        assert_eq!(changed, vec!["secret", "src/main.rs"]);
    }

    #[tokio::test]
    async fn verification_does_not_inherit_host_environment_and_fails_on_exit() {
        let dir = tempfile::tempdir().unwrap();
        let env = BTreeMap::from([("PATH".into(), "/usr/bin:/bin".into())]);
        let check = run_check(&["/usr/bin/env".into()], dir.path(), &env, 2)
            .await
            .unwrap();
        assert!(check.passed);
        assert_eq!(check.stdout.trim(), "PATH=/usr/bin:/bin");
        let check = run_check(&["/usr/bin/false".into()], dir.path(), &env, 2)
            .await
            .unwrap();
        assert!(!check.passed);
    }

    #[test]
    fn family_cluster_interval_is_deterministic() {
        let clusters = vec![vec![1.0, 0.0], vec![0.0], vec![1.0]];
        assert_eq!(
            cluster_interval(&clusters, 42),
            cluster_interval(&clusters, 42)
        );
        assert_eq!(
            cluster_interval(&[vec![1.0], vec![1.0], vec![1.0]], 42),
            (1.0, 1.0)
        );
    }

    fn example_sample(
        family: &str,
        trial: u32,
        mode: EvaluationMode,
        success: bool,
    ) -> EvaluationSample {
        EvaluationSample {
            task_id: family.into(),
            family: family.into(),
            split: TaskSplit::Validation,
            trial,
            mode,
            snapshot_id: format!("{}-snapshot", mode.label()),
            context_hash: if mode == EvaluationMode::None {
                digest(b"")
            } else {
                "context".into()
            },
            workspace: "unused".into(),
            source_tree: "tree".into(),
            environment_fingerprint: "env".into(),
            execution: Some(Execution {
                events: vec![],
                output: String::new(),
                exit_reason: "completed".into(),
                elapsed_ms: 1,
                input_tokens: None,
                output_tokens: None,
                complete: true,
            }),
            checks: vec![VerificationResult {
                argv: vec!["check".into()],
                passed: success,
                exit_code: Some(if success { 0 } else { 1 }),
                stdout: String::new(),
                stderr: String::new(),
                timed_out: false,
                output_truncated: false,
            }],
            changed_paths: vec![],
            outside_scope: vec![],
            success,
            error: None,
            cost_usd: None,
        }
    }
    fn example_report() -> EvaluationReport {
        let mut samples = vec![];
        for family in ["one", "two", "three"] {
            for trial in 0..2 {
                samples.push(example_sample(family, trial, EvaluationMode::None, false));
                samples.push(example_sample(family, trial, EvaluationMode::Raw, false));
                samples.push(example_sample(
                    family,
                    trial,
                    EvaluationMode::Current,
                    false,
                ));
                samples.push(example_sample(
                    family,
                    trial,
                    EvaluationMode::Revision,
                    true,
                ));
            }
        }
        let manifest = SuiteManifest {
            suite_id: "suite".into(),
            tasks: ["one", "two", "three"]
                .into_iter()
                .map(|family| EvaluationTask {
                    id: family.into(),
                    family: family.into(),
                    split: TaskSplit::Validation,
                    repo: "unused".into(),
                    start_commit: "a".repeat(40),
                    prompt: "repair".into(),
                    verification: vec![vec!["check".into()]],
                    allowed_paths: vec!["file".into()],
                    environment: Default::default(),
                })
                .collect(),
        };
        EvaluationReport {
            schema_version: 1,
            trials: 2,
            redacted: true,
            suite_id: "suite".into(),
            suite_fingerprint: fingerprint(&manifest).unwrap(),
            manifest,
            config_fingerprint: "config-hash".into(),
            runner: RunnerConfig::default(),
            host_os: "test".into(),
            host_arch: "test".into(),
            created_at: "test".into(),
            samples,
        }
    }
    #[test]
    fn promotion_requires_positive_sufficient_validation_and_no_family_regression() {
        let mut report = example_report();
        let comparison = compare_reports(&report, &report).unwrap();
        assert!(comparison.eligible);
        assert_eq!(comparison.candidate_snapshot_ids, vec!["revision-snapshot"]);
        for sample in &mut report.samples {
            sample.split = TaskSplit::Final;
        }
        for task in &mut report.manifest.tasks {
            task.split = TaskSplit::Final;
        }
        report.suite_fingerprint = fingerprint(&report.manifest).unwrap();
        assert!(
            !compare_modes(
                &report,
                EvaluationMode::Current,
                EvaluationMode::Revision,
                TaskSplit::Final
            )
            .unwrap()
            .eligible
        );
        report.samples.retain(|sample| sample.family == "one");
        report.manifest.tasks.retain(|task| task.family == "one");
        for sample in &mut report.samples {
            sample.split = TaskSplit::Validation;
        }
        for task in &mut report.manifest.tasks {
            task.split = TaskSplit::Validation;
        }
        report.suite_fingerprint = fingerprint(&report.manifest).unwrap();
        assert!(!compare_reports(&report, &report).unwrap().eligible);
        let mut report = example_report();
        for sample in report.samples.iter_mut().filter(|s| s.family == "one") {
            let success = sample.mode == EvaluationMode::Current;
            sample.success = success;
            sample.checks[0].passed = success;
            sample.checks[0].exit_code = Some(if success { 0 } else { 1 });
        }
        let comparison = compare_reports(&report, &report).unwrap();
        assert!(!comparison.eligible);
        assert!(comparison.per_family.iter().any(|f| f.regression));
    }
    #[test]
    fn unmatched_trials_and_changed_settings_are_rejected() {
        let report = example_report();
        let mut changed = report.clone();
        changed.samples.pop();
        assert!(compare_reports(&report, &changed).is_err());
        let mut changed = report.clone();
        changed.config_fingerprint = "different".into();
        assert!(compare_reports(&report, &changed).is_err());
    }
    #[tokio::test]
    async fn exports_only_pinned_source_and_fresh_local_history() {
        let temporary = tempfile::tempdir().unwrap();
        let repo = temporary.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "--quiet"]).await.unwrap();
        std::fs::write(repo.join("file"), "baseline").unwrap();
        git(&repo, &["add", "file"]).await.unwrap();
        git(
            &repo,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@invalid",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "--quiet",
                "-m",
                "source",
            ],
        )
        .await
        .unwrap();
        let commit = git(&repo, &["rev-parse", "HEAD"]).await.unwrap();
        std::fs::write(repo.join("file"), "dirty").unwrap();
        std::fs::write(repo.join("answer"), "secret host answer").unwrap();
        let task = EvaluationTask {
            id: "test".into(),
            family: "test".into(),
            split: TaskSplit::Validation,
            repo: repo.clone(),
            start_commit: commit.clone(),
            prompt: "repair".into(),
            verification: vec![vec!["true".into()]],
            allowed_paths: vec!["file".into()],
            environment: Default::default(),
        };
        let (workspace, _) = export_workspace(&task, &temporary.path().join("export"))
            .await
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(workspace.join("file")).unwrap(),
            "baseline"
        );
        assert!(!workspace.join("answer").exists());
        assert_eq!(
            git(&workspace, &["rev-list", "--all", "--count"])
                .await
                .unwrap(),
            "1"
        );
        assert_ne!(
            git(&workspace, &["rev-parse", "HEAD"]).await.unwrap(),
            commit
        );
        assert!(git(&workspace, &["remote"]).await.unwrap().is_empty());
        assert_eq!(std::fs::read_to_string(repo.join("file")).unwrap(), "dirty");
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn full_four_mode_run_rejects_scope_violation_and_tracks_missing_cost() {
        if std::env::var_os("KINIC_TEST_EVAL_CREDENTIAL").is_none() {
            let status = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "learning_evaluation::tests::full_four_mode_run_rejects_scope_violation_and_tracks_missing_cost", "--nocapture"])
                .env("KINIC_TEST_EVAL_CREDENTIAL", "fixture-secret-do-not-save")
                .status().unwrap();
            assert!(status.success());
            return;
        }
        use std::os::unix::fs::PermissionsExt;
        let temporary = tempfile::tempdir().unwrap();
        let repo = temporary.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "--quiet"]).await.unwrap();
        std::fs::write(repo.join("file"), "baseline").unwrap();
        git(&repo, &["add", "file"]).await.unwrap();
        git(
            &repo,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@invalid",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "--quiet",
                "-m",
                "source",
            ],
        )
        .await
        .unwrap();
        let executable = temporary.path().join("fake-agent.py");
        std::fs::write(&executable,"#!/usr/bin/env python3\nimport sys,json,pathlib,os\nprompt=sys.stdin.read()\nprint(json.dumps({'type':'item.completed','item':{'type':'agent_message','text':os.environ['KINIC_TEST_EVAL_CREDENTIAL']+os.environ['OPENAI_API_KEY']}}))\npathlib.Path('file').write_text('fixed')\nif 'bad-context' in prompt: pathlib.Path('outside').write_text('bad')\nprint(json.dumps({'type':'turn.completed','usage':{'input_tokens':2,'output_tokens':3}}))\n").unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        let task = EvaluationTask {
            id: "test".into(),
            family: "test".into(),
            split: TaskSplit::Validation,
            repo: repo.clone(),
            start_commit: git(&repo, &["rev-parse", "HEAD"]).await.unwrap(),
            prompt: format!(
                "repair {}",
                std::env::var("KINIC_TEST_EVAL_CREDENTIAL").unwrap()
            ),
            verification: vec![vec![
                "/bin/sh".into(),
                "-c".into(),
                "test -z \"${KINIC_TEST_EVAL_CREDENTIAL+x}\" && test -z \"${OPENAI_API_KEY+x}\""
                    .into(),
            ]],
            allowed_paths: vec!["file".into()],
            environment: Default::default(),
        };
        let contexts = BTreeMap::from([(
            "test".into(),
            EvaluationMode::ALL
                .into_iter()
                .map(|mode| {
                    (
                        mode,
                        PreparedContext {
                            snapshot_id: mode.label().into(),
                            content: if mode == EvaluationMode::Revision {
                                "bad-context".into()
                            } else {
                                String::new()
                            },
                        },
                    )
                })
                .collect(),
        )]);
        let config: RunnerConfig = serde_json::from_value(serde_json::json!({
            "executable": executable,
            "inherited_environment": ["KINIC_TEST_EVAL_CREDENTIAL"],
            "environment": {"OPENAI_API_KEY":"legacy-fixture-secret"}
        }))
        .unwrap();
        // /tmp is /private/tmp on macOS; the evaluator forbids that destination.
        let output_parent = tempfile::tempdir_in(std::env::current_dir().unwrap()).unwrap();
        let report = evaluate_suite(
            &SuiteManifest {
                suite_id: "test-suite".into(),
                tasks: vec![task],
            },
            &config,
            &contexts,
            &output_parent.path().join("results"),
            1,
        )
        .await
        .unwrap();
        let mut missing = config.clone();
        missing.inherited_environment = vec!["KINIC_TEST_MISSING_EVAL_CREDENTIAL_A947BC".into()];
        let error = evaluate_suite(
            &report.manifest,
            &missing,
            &contexts,
            &output_parent.path().join("missing-credential"),
            1,
        )
        .await
        .unwrap_err()
        .to_string();
        assert!(error.contains("required inherited environment variable is unavailable"));
        assert!(!error.contains("fixture-secret-do-not-save"));
        assert!(!error.contains("legacy-fixture-secret"));
        assert_eq!(report.samples.len(), 4);
        validate_report(&report).unwrap();
        assert!(report.redacted);
        for entry in std::fs::read_dir(output_parent.path().join("results")).unwrap() {
            let path = entry.unwrap().path();
            let artifact = if path.is_dir() {
                path.join("sample.json")
            } else {
                path
            };
            let text = std::fs::read_to_string(artifact).unwrap();
            assert!(!text.contains("fixture-secret-do-not-save"));
            assert!(!text.contains("legacy-fixture-secret"));
        }

        assert_eq!(report.runner.environment["OPENAI_API_KEY"], "[REDACTED]");
        assert!(
            !serde_json::to_string(&report)
                .unwrap()
                .contains("fixture-secret-do-not-save")
        );
        assert!(
            !std::fs::read_to_string(output_parent.path().join("results/report.json"))
                .unwrap()
                .contains("fixture-secret-do-not-save")
        );
        assert!(
            report
                .samples
                .iter()
                .filter(|s| s.mode != EvaluationMode::Revision)
                .all(|s| s.success)
        );
        let revision = report
            .samples
            .iter()
            .find(|s| s.mode == EvaluationMode::Revision)
            .unwrap();
        assert!(!revision.success);
        assert_eq!(revision.outside_scope, vec!["outside"]);
        assert!(revision.cost_usd.is_none());
        assert_eq!(revision.execution.as_ref().unwrap().input_tokens, Some(2));
        assert_eq!(
            std::fs::read_to_string(repo.join("file")).unwrap(),
            "baseline"
        );
    }
    #[test]
    fn families_cannot_cross_validation_and_final() {
        let task = EvaluationTask {
            id: "one".into(),
            family: "same-family".into(),
            split: TaskSplit::Validation,
            repo: "unused".into(),
            start_commit: "a".repeat(40),
            prompt: "repair".into(),
            verification: vec![vec!["true".into()]],
            allowed_paths: vec!["file".into()],
            environment: Default::default(),
        };
        let mut second = task.clone();
        second.id = "two".into();
        second.split = TaskSplit::Final;
        let suite = SuiteManifest {
            suite_id: "suite".into(),
            tasks: vec![task, second],
        };
        assert!(
            suite
                .validate()
                .unwrap_err()
                .to_string()
                .contains("crosses")
        );
    }
    #[tokio::test]
    async fn verifier_timeout_never_succeeds() {
        let directory = tempfile::tempdir().unwrap();
        let result = run_check(
            &["/bin/sleep".into(), "2".into()],
            directory.path(),
            &BTreeMap::new(),
            1,
        )
        .await
        .unwrap();
        assert!(result.timed_out);
        assert!(!result.passed);
    }
    #[test]
    fn persisted_success_flags_cannot_override_failed_evidence() {
        for corrupt in 0..5 {
            let mut report = example_report();
            let sample = report
                .samples
                .iter_mut()
                .find(|s| s.mode == EvaluationMode::Revision)
                .unwrap();
            match corrupt {
                0 => sample.checks[0].exit_code = Some(1),
                1 => sample.checks[0].timed_out = true,
                2 => sample.checks[0].output_truncated = true,
                3 => sample.execution.as_mut().unwrap().exit_reason = "timeout".into(),
                _ => sample.changed_paths.push("outside-allowed-path".into()),
            }
            assert!(
                validate_report(&report).is_err(),
                "accepted corruption {corrupt}"
            );
            assert!(compare_reports(&report, &report).is_err());
        }
    }
}
