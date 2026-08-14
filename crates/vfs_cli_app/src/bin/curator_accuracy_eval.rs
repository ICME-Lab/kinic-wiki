// Where: Reusable Curator staging accuracy evaluator entrypoint.
// What: Prepare answer-masked labeling input and score strict labels against scan and plan artifacts.
// Why: Operators need reproducible real-content accuracy evidence without mutating staging.
use anyhow::Result;
use clap::{Parser, Subcommand, ValueEnum};
use std::path::PathBuf;
use vfs_cli_app::curator_accuracy::{
    compare_annotation_files, finalize_labels_file, prepare_file, score_file,
    score_file_with_seed_manifest,
};
use vfs_cli_app::curator_accuracy_seed::{
    generate_seed_files, prepare_seed_repair, validate_seed_batch, validate_seed_definition,
    verify_seed_files,
};

#[derive(Clone, Copy, Debug, ValueEnum)]
enum SeedBatchMode {
    Initial,
    Repair,
}

#[derive(Debug, Parser)]
#[command(about = "Prepare and score provisional AI-only Curator staging accuracy evaluations")]
struct Args {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    #[command(about = "Generate deterministic private staging seed batches and an oracle manifest")]
    Seed {
        #[arg(long)]
        out_dir: PathBuf,
        #[arg(long, default_value = "curator-accuracy-v1")]
        seed_id: String,
        #[arg(long)]
        overwrite: bool,
    },
    #[command(about = "Verify a scan against a deterministic seed manifest")]
    VerifySeed {
        #[arg(long)]
        scan: PathBuf,
        #[arg(long)]
        manifest: PathBuf,
        #[arg(long)]
        out: PathBuf,
        #[arg(long)]
        allow_partial: bool,
        #[arg(long)]
        overwrite: bool,
    },
    #[command(about = "Create one private, etag-guarded batch for changed seed content")]
    RepairSeed {
        #[arg(long)]
        scan: PathBuf,
        #[arg(long)]
        manifest: PathBuf,
        #[arg(long)]
        definition_dir: PathBuf,
        #[arg(long)]
        out: PathBuf,
        #[arg(long)]
        batch_index: Option<usize>,
        #[arg(long)]
        overwrite: bool,
    },
    #[command(about = "Validate every retained initial seed batch against its manifest")]
    ValidateSeedDefinition {
        #[arg(long)]
        manifest: PathBuf,
        #[arg(long)]
        definition_dir: PathBuf,
    },
    #[command(about = "Validate the exact seed batch that will be passed to write-nodes")]
    ValidateSeedBatch {
        #[arg(long)]
        manifest: PathBuf,
        #[arg(long)]
        input: PathBuf,
        #[arg(long)]
        batch_index: usize,
        #[arg(long, value_enum)]
        mode: SeedBatchMode,
        #[arg(long, required_if_eq("mode", "repair"))]
        scan: Option<PathBuf>,
    },
    #[command(about = "Create a private answer-masked labeling input without findings")]
    Prepare {
        #[arg(long)]
        scan: PathBuf,
        #[arg(long)]
        out: PathBuf,
        #[arg(long)]
        overwrite: bool,
    },
    #[command(about = "Compare two strict AI annotation artifacts and emit only disputes")]
    CompareAnnotations {
        #[arg(long)]
        input: PathBuf,
        #[arg(long)]
        annotation_a: PathBuf,
        #[arg(long)]
        annotation_b: PathBuf,
        #[arg(long)]
        out: PathBuf,
        #[arg(long)]
        overwrite: bool,
    },
    #[command(about = "Finalize labels from two annotations and an optional exact adjudication")]
    FinalizeLabels {
        #[arg(long)]
        input: PathBuf,
        #[arg(long)]
        annotation_a: PathBuf,
        #[arg(long)]
        annotation_b: PathBuf,
        #[arg(long)]
        adjudication: Option<PathBuf>,
        #[arg(long)]
        out: PathBuf,
        #[arg(long)]
        overwrite: bool,
    },
    #[command(about = "Score private labels and an optional Curator plan")]
    Score {
        #[arg(long)]
        scan: PathBuf,
        #[arg(long)]
        labels: PathBuf,
        #[arg(long)]
        plan: Option<PathBuf>,
        #[arg(long)]
        seed_manifest: Option<PathBuf>,
        #[arg(long)]
        out: PathBuf,
        #[arg(long)]
        overwrite: bool,
    },
}

fn main() -> Result<()> {
    match Args::parse().command {
        Command::Seed {
            out_dir,
            seed_id,
            overwrite,
        } => {
            let manifest = generate_seed_files(&out_dir, &seed_id, overwrite)?;
            println!(
                "private seed written: {} (seed_files={}, total_nodes={}, batches={})",
                out_dir.display(),
                manifest.non_folder_node_count,
                manifest.nodes.len(),
                manifest.batches.len(),
            );
        }
        Command::VerifySeed {
            scan,
            manifest,
            out,
            allow_partial,
            overwrite,
        } => {
            let report = verify_seed_files(&scan, &manifest, &out, allow_partial, overwrite)?;
            println!(
                "seed verification written: {} (complete={}, mismatches={}, finding_fp={}, finding_fn={})",
                out.display(),
                report.complete,
                report.content_mismatches.len(),
                report.unexpected_findings.len(),
                report.missing_findings.len(),
            );
        }
        Command::RepairSeed {
            scan,
            manifest,
            definition_dir,
            out,
            batch_index,
            overwrite,
        } => {
            let count = prepare_seed_repair(
                &scan,
                &manifest,
                &definition_dir,
                &out,
                batch_index,
                overwrite,
            )?;
            println!(
                "private etag-guarded seed repair written: {} (nodes={count})",
                out.display()
            );
        }
        Command::ValidateSeedDefinition {
            manifest,
            definition_dir,
        } => {
            let count = validate_seed_definition(&manifest, &definition_dir)?;
            println!(
                "seed definition valid: {} (nodes={count})",
                definition_dir.display()
            );
        }
        Command::ValidateSeedBatch {
            manifest,
            input,
            batch_index,
            mode,
            scan,
        } => {
            let scan = match mode {
                SeedBatchMode::Initial => None,
                SeedBatchMode::Repair => scan.as_deref(),
            };
            let count = validate_seed_batch(&manifest, &input, batch_index, scan)?;
            println!("seed batch valid: {} (nodes={count})", input.display());
        }
        Command::Prepare {
            scan,
            out,
            overwrite,
        } => {
            prepare_file(&scan, &out, overwrite)?;
            println!(
                "private answer-masked labeling input written: {}",
                out.display()
            );
        }
        Command::CompareAnnotations {
            input,
            annotation_a,
            annotation_b,
            out,
            overwrite,
        } => {
            let disputes =
                compare_annotation_files(&input, &annotation_a, &annotation_b, &out, overwrite)?;
            println!(
                "annotation disputes written: {} (deterministic={}, semantic={})",
                out.display(),
                disputes.deterministic.len(),
                disputes.semantic.len(),
            );
        }
        Command::FinalizeLabels {
            input,
            annotation_a,
            annotation_b,
            adjudication,
            out,
            overwrite,
        } => {
            let labels = finalize_labels_file(
                &input,
                &annotation_a,
                &annotation_b,
                adjudication.as_deref(),
                &out,
                overwrite,
            )?;
            println!(
                "accuracy labels written: {} (annotators=2, adjudicated={})",
                out.display(),
                labels.adjudicated_disagreements,
            );
        }
        Command::Score {
            scan,
            labels,
            plan,
            seed_manifest,
            out,
            overwrite,
        } => {
            let report = match seed_manifest {
                Some(manifest) => score_file_with_seed_manifest(
                    &scan,
                    &labels,
                    plan.as_deref(),
                    &manifest,
                    &out,
                    overwrite,
                )?,
                None => score_file(&scan, &labels, plan.as_deref(), &out, overwrite)?,
            };
            println!(
                "provisional AI evaluation written: {} (overall={:?}, deterministic={:?}, semantic={:?})",
                out.display(),
                report.overall_verdict,
                report.deterministic.verdict,
                report.semantic.verdict,
            );
        }
    }
    Ok(())
}
