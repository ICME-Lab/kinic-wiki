// Where: crates/vfs_cli_app/src/bin/beam_bench.rs
// What: Dedicated BEAM-derived retrieval benchmark binary.
// Why: Benchmark harness concerns should stay outside the normal wiki operation CLI.
use anyhow::Result;
use clap::{Parser, ValueEnum};
use std::path::PathBuf;
use vfs_cli::connection::resolve_connection;
use vfs_cli_app::beam_bench::{
    BeamBenchArgs, BeamBenchEvalMode, BeamQuestionClass, run_beam_bench,
};
use vfs_cli_app::cli::ConnectionArgs;

#[derive(Parser, Debug)]
#[command(name = "beam-bench")]
#[command(about = "Run the read-only BEAM-derived wiki retrieval benchmark harness")]
struct Cli {
    #[command(flatten)]
    connection: ConnectionArgs,

    #[arg(long)]
    dataset_path: PathBuf,
    #[arg(long, default_value = "100K")]
    split: String,
    #[arg(long, default_value = "")]
    model: String,
    #[arg(long)]
    output_dir: PathBuf,
    #[arg(long, value_enum, default_value_t = EvalModeArg::RetrieveAndExtract)]
    eval_mode: EvalModeArg,
    #[arg(long, default_value_t = 1)]
    limit: usize,
    #[arg(long, default_value_t = 1)]
    parallelism: usize,
    #[arg(long, default_value_t = 10)]
    top_k: u32,
    #[arg(long)]
    questions_per_conversation: Option<usize>,
    #[arg(long)]
    question_id: Option<String>,
    #[arg(long, value_enum)]
    include_question_class: Vec<QuestionClassArg>,
    #[arg(long)]
    include_tag: Vec<String>,
    #[arg(long)]
    include_question_type: Vec<String>,
    #[arg(long)]
    namespace: Option<String>,
    #[arg(
        long,
        help = "Resume from existing results.jsonl and run only unanswered questions"
    )]
    resume: bool,
    #[arg(long, default_value = "codex")]
    codex_bin: PathBuf,
    #[arg(long, default_value = "danger-full-access")]
    codex_sandbox: String,
}

#[derive(ValueEnum, Debug, Clone, Copy, PartialEq, Eq)]
enum EvalModeArg {
    RetrievalOnly,
    RetrieveAndExtract,
}

#[derive(ValueEnum, Debug, Clone, Copy, PartialEq, Eq)]
enum QuestionClassArg {
    Factoid,
    Reasoning,
    Abstention,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    let connection = resolve_connection(
        cli.connection.local,
        cli.connection.replica_host.clone(),
        cli.connection.canister_id.clone(),
        cli.connection.database_id.clone(),
    )?;
    let database_id = connection
        .database_id
        .clone()
        .ok_or_else(|| anyhow::anyhow!("--database-id is required"))?;
    run_beam_bench(
        connection,
        BeamBenchArgs {
            dataset_path: cli.dataset_path,
            split: cli.split,
            database_id,
            model: cli.model,
            output_dir: cli.output_dir,
            eval_mode: match cli.eval_mode {
                EvalModeArg::RetrievalOnly => BeamBenchEvalMode::RetrievalOnly,
                EvalModeArg::RetrieveAndExtract => BeamBenchEvalMode::RetrieveAndExtract,
            },
            limit: cli.limit,
            parallelism: cli.parallelism,
            top_k: cli.top_k,
            questions_per_conversation: cli.questions_per_conversation,
            question_id: cli.question_id,
            include_question_classes: cli
                .include_question_class
                .into_iter()
                .map(|value| match value {
                    QuestionClassArg::Factoid => BeamQuestionClass::Factoid,
                    QuestionClassArg::Reasoning => BeamQuestionClass::Reasoning,
                    QuestionClassArg::Abstention => BeamQuestionClass::Abstention,
                })
                .collect(),
            include_tags: cli.include_tag,
            include_question_types: cli.include_question_type,
            namespace: cli.namespace,
            codex_bin: cli.codex_bin,
            codex_sandbox: cli.codex_sandbox,
            resume: cli.resume,
        },
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::Cli;
    use clap::CommandFactory;

    #[test]
    fn dedicated_bin_help_mentions_beam_bench() {
        let mut command = Cli::command();
        let help = command.render_long_help().to_string();

        assert!(help.contains("beam-bench"));
        assert!(help.contains("Run the read-only BEAM-derived wiki retrieval benchmark harness"));
        assert!(!help.contains("legacy-agent-answer"));
        assert!(!help.contains("--provider"));
        assert!(!help.contains("OPENAI_API_KEY"));
    }
}
