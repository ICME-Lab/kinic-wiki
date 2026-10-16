//! Additive CLI commands; all remote operations share the existing connection and identity.
use clap::{Args, Subcommand};
use std::path::PathBuf;
#[derive(Args, Debug, Clone)]
pub struct StateArgs {
    #[arg(long)]
    pub state_dir: Option<PathBuf>,
    #[arg(long)]
    pub json: bool,
}
#[derive(Subcommand, Debug, Clone)]
pub enum AgentCommand {
    /// Prepare configuration and plugin files; does not start an engine.
    Setup(SetupArgs),
    /// Diagnose configuration and read access without executing agents or repairing state.
    Doctor(DoctorArgs),
    /// Read locally observed learning progress without syncing, executing or creating state.
    Status(StatusArgs),
    Run {
        #[arg(long)]
        task: String,
        #[arg(long, required_unless_present = "engine")]
        runner_file: Option<PathBuf>,
        #[arg(long, value_parser = ["codex", "dsh"])]
        engine: Option<String>,
        #[arg(long)]
        recall_config: Option<PathBuf>,
        #[arg(skip)]
        stdin_config: Option<serde_json::Value>,
        #[arg(long)]
        verification_file: Option<PathBuf>,
        #[arg(long)]
        cwd: Option<PathBuf>,
        #[command(flatten)]
        state: StateArgs,
    },
    Recall {
        #[arg(long)]
        task: String,
        #[arg(long)]
        recall_config: Option<PathBuf>,
        #[arg(skip)]
        stdin_config: Option<serde_json::Value>,
        #[arg(long)]
        cwd: Option<PathBuf>,
        #[arg(long)]
        run_id: Option<String>,
        #[command(flatten)]
        state: StateArgs,
    },
    Record {
        #[arg(long)]
        cwd: Option<PathBuf>,
        #[arg(long)]
        event_file: PathBuf,
        #[command(flatten)]
        state: StateArgs,
    },
    Flush {
        #[arg(long)]
        cwd: Option<PathBuf>,
        #[command(flatten)]
        state: StateArgs,
    },
    Hook {
        #[arg(long)]
        cwd: Option<PathBuf>,
        #[arg(skip)]
        request: Option<serde_json::Value>,
        #[arg(long)]
        engine: String,
        #[arg(long)]
        recall_config: Option<PathBuf>,
        #[command(flatten)]
        state: StateArgs,
    },
}
#[derive(Subcommand, Debug, Clone)]
pub enum LearnCommand {
    Setup {
        #[arg(long, default_value = ".")]
        project_root: PathBuf,
        #[arg(long)]
        runner_file: PathBuf,
        #[arg(long)]
        validation_suite: Option<PathBuf>,
        #[arg(long = "shared-scope")]
        shared_scope: Vec<String>,
        #[command(flatten)]
        state: StateArgs,
    },
    Status {
        #[arg(long, default_value = ".")]
        project_root: PathBuf,
        #[command(flatten)]
        state: StateArgs,
    },
    Enable {
        #[arg(long, default_value = ".")]
        project_root: PathBuf,
        #[command(flatten)]
        state: StateArgs,
    },
    Disable {
        #[arg(long, default_value = ".")]
        project_root: PathBuf,
        #[command(flatten)]
        state: StateArgs,
    },
    Drain {
        #[arg(long, default_value = ".")]
        project_root: PathBuf,
        #[arg(long)]
        recall_config: Option<PathBuf>,
        #[command(flatten)]
        state: StateArgs,
    },
    Propose {
        #[arg(long)]
        run_id: String,
        #[arg(long)]
        runner_file: PathBuf,
        #[command(flatten)]
        state: StateArgs,
    },
    Evaluate {
        #[arg(long)]
        no_auto_promote: bool,
        #[arg(long)]
        candidate_path: String,
        #[arg(long)]
        suite: PathBuf,
        #[arg(long)]
        runner_file: PathBuf,
        #[arg(long)]
        recall_config: PathBuf,
        #[arg(long)]
        output: PathBuf,
        #[arg(long, default_value_t = 3)]
        trials: u32,
        #[command(flatten)]
        state: StateArgs,
    },
    Promote {
        #[arg(long)]
        candidate_path: String,
        #[arg(long)]
        evaluation_path: String,
        #[command(flatten)]
        state: StateArgs,
    },
    Rollback {
        #[arg(long)]
        publication_path: String,
        #[command(flatten)]
        state: StateArgs,
    },
}
#[derive(Subcommand, Debug, Clone)]
pub enum EvalCommand {
    Run {
        #[arg(long)]
        suite: PathBuf,
        #[arg(long)]
        runner_file: PathBuf,
        #[arg(long)]
        contexts: PathBuf,
        #[arg(long)]
        output: PathBuf,
        #[arg(long, default_value_t = 3)]
        trials: u32,
        #[arg(long)]
        json: bool,
    },
    Compare {
        #[arg(long)]
        baseline: PathBuf,
        #[arg(long)]
        candidate: PathBuf,
        #[arg(long)]
        json: bool,
    },
    Report {
        #[arg(long)]
        report_file: PathBuf,
        #[arg(long)]
        json: bool,
    },
}
#[derive(Subcommand, Debug, Clone)]
pub enum DshCommand {
    Setup {
        #[arg(long)]
        output: Option<PathBuf>,
        #[arg(long)]
        recall_config: Option<PathBuf>,
        #[arg(long)]
        executable: Option<PathBuf>,
        #[arg(long)]
        project: bool,
        #[arg(long, conflicts_with = "dry_run")]
        apply: bool,
        #[arg(long)]
        dry_run: bool,
        #[arg(long)]
        json: bool,
    },
}

impl AgentCommand {
    /// Preserve stdin in memory; neither discovery nor recall may reread the stream.
    pub fn capture_recall_stdin(&mut self) -> anyhow::Result<()> {
        let (path, cached) = match self {
            Self::Run {
                runner_file,
                recall_config,
                stdin_config,
                ..
            } => {
                anyhow::ensure!(
                    runner_file.as_deref() != Some(std::path::Path::new("-"))
                        || recall_config.as_deref() != Some(std::path::Path::new("-")),
                    "runner and recall configuration cannot both read stdin"
                );
                (recall_config, stdin_config)
            }
            Self::Recall {
                recall_config,
                stdin_config,
                ..
            } => (recall_config, stdin_config),
            _ => return Ok(()),
        };
        if path.as_deref() == Some(std::path::Path::new("-")) && cached.is_none() {
            let value = crate::agent_config::read_json_value(std::path::Path::new("-"))?;
            anyhow::ensure!(
                value.is_object(),
                "stdin recall configuration must be a JSON object"
            );
            anyhow::ensure!(
                value["version"] != 2,
                "portable project configuration requires an on-disk file"
            );
            *cached = Some(value);
        }
        Ok(())
    }
    pub fn cwd(&self) -> Option<&PathBuf> {
        match self {
            Self::Run { cwd, .. }
            | Self::Recall { cwd, .. }
            | Self::Record { cwd, .. }
            | Self::Flush { cwd, .. }
            | Self::Hook { cwd, .. } => cwd.as_ref(),
            Self::Setup(args) => args.cwd.as_ref(),
            Self::Doctor(args) => args.cwd.as_ref(),
            Self::Status(args) => args.cwd.as_ref(),
        }
    }
}

#[derive(Args, Debug, Clone, Default)]
pub struct SetupArgs {
    #[arg(long, value_parser = ["codex", "dsh"])]
    pub engine: String,
    #[arg(long)]
    pub executable: Option<PathBuf>,
    /// Store the machine-specific executable in project configuration instead of user configuration.
    #[arg(long)]
    pub project: bool,
    /// Apply the displayed replacements of existing files.
    #[arg(long, conflicts_with = "dry_run")]
    pub apply: bool,
    #[arg(long)]
    pub dry_run: bool,
    /// DSH package output directory. Does not install into an active profile.
    #[arg(long)]
    pub output: Option<PathBuf>,
    /// Existing RecallOptions JSON, retained for dsh setup compatibility.
    #[arg(long)]
    pub recall_config: Option<PathBuf>,
    #[arg(long)]
    pub cwd: Option<PathBuf>,
    #[arg(long)]
    pub json: bool,
}
#[derive(Args, Debug, Clone)]
pub struct StatusArgs {
    #[arg(long)]
    pub cwd: Option<PathBuf>,
    /// Optional existing project/recall JSON; stdin is not accepted by status.
    #[arg(long)]
    pub recall_config: Option<PathBuf>,
    #[command(flatten)]
    pub state: StateArgs,
}
#[derive(Args, Debug, Clone)]
pub struct DoctorArgs {
    #[arg(long, value_parser = ["codex", "dsh"])]
    pub engine: Option<String>,
    #[arg(long)]
    pub strict: bool,
    #[arg(long)]
    pub json: bool,
    #[arg(long)]
    pub cwd: Option<PathBuf>,
}

impl AgentCommand {
    /// Resolve and store one absolute target before the process working directory changes.
    pub fn resolve_cwd(&mut self, base: &std::path::Path) -> anyhow::Result<Option<PathBuf>> {
        let cwd = match self {
            Self::Run { cwd, .. }
            | Self::Recall { cwd, .. }
            | Self::Record { cwd, .. }
            | Self::Flush { cwd, .. }
            | Self::Hook { cwd, .. } => cwd,
            Self::Setup(args) => &mut args.cwd,
            Self::Doctor(args) => &mut args.cwd,
            Self::Status(args) => &mut args.cwd,
        };
        if let Some(path) = cwd {
            *path = if path.is_absolute() {
                path.canonicalize()?
            } else {
                base.join(&*path).canonicalize()?
            };
        }
        Ok(cwd.clone())
    }
    /// Explicit CLI paths keep their invocation-directory meaning even with --cwd.
    pub fn anchor_paths(&mut self, base: &std::path::Path) {
        fn anchor(path: &mut Option<PathBuf>, base: &std::path::Path) {
            if let Some(path) = path
                && path.is_relative()
                && path != std::path::Path::new("-")
            {
                *path = base.join(&*path);
            }
        }
        match self {
            Self::Run {
                runner_file,
                recall_config,
                verification_file,
                state,
                ..
            } => {
                anchor(runner_file, base);
                anchor(recall_config, base);
                anchor(verification_file, base);
                anchor(&mut state.state_dir, base);
            }
            Self::Recall {
                recall_config,
                state,
                ..
            }
            | Self::Hook {
                recall_config,
                state,
                ..
            } => {
                anchor(recall_config, base);
                anchor(&mut state.state_dir, base);
            }
            Self::Record {
                event_file, state, ..
            } => {
                if event_file.is_relative() && event_file != std::path::Path::new("-") {
                    *event_file = base.join(&*event_file);
                }
                anchor(&mut state.state_dir, base);
            }
            Self::Flush { state, .. } => anchor(&mut state.state_dir, base),
            Self::Status(args) => {
                anchor(&mut args.recall_config, base);
                anchor(&mut args.state.state_dir, base);
            }
            Self::Setup(args) => {
                anchor(&mut args.output, base);
                anchor(&mut args.recall_config, base);
                if args
                    .executable
                    .as_ref()
                    .is_some_and(|p| p.is_relative() && p.components().count() > 1)
                {
                    anchor(&mut args.executable, base);
                }
            }
            Self::Doctor(_) => {}
        }
    }
}
