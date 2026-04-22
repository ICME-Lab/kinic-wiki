// Where: crates/wiki_cli/src/bin/vfs_bench.rs
// What: Entry point for deployed-canister workload and latency benchmarks.
// Why: We need one typed Rust client binary that shell wrappers can drive into JSON artifacts.
mod vfs_bench {
    pub mod common;
    pub mod latency;
    pub mod workload;
}

use anyhow::Result;
use clap::{Parser, Subcommand, ValueEnum};
use std::fs;
use wiki_cli::connection::resolve_connection;
use wiki_types::SearchPreviewMode;

use vfs_bench::common::{
    DirectoryShape, LatencyOperation, MeasurementMode, SetupStats, WorkloadOperation,
};
use vfs_bench::latency::{
    LatencyBenchArgs, measure_latency_bench, run_latency_bench, setup_latency_bench,
};
use vfs_bench::workload::{
    WorkloadBenchArgs, measure_workload_bench, run_workload_bench, setup_workload_bench,
};

#[derive(Parser, Debug)]
#[command(name = "vfs-bench")]
#[command(about = "Run deployed-canister VFS benchmarks and emit aggregated JSON")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum BenchSearchPreviewMode {
    None,
    Light,
}

impl From<BenchSearchPreviewMode> for SearchPreviewMode {
    fn from(value: BenchSearchPreviewMode) -> Self {
        match value {
            BenchSearchPreviewMode::None => SearchPreviewMode::None,
            BenchSearchPreviewMode::Light => SearchPreviewMode::Light,
        }
    }
}

#[derive(Subcommand, Debug)]
enum Command {
    Workload {
        #[arg(long)]
        output_json: String,
        #[arg(long)]
        benchmark_name: String,
        #[arg(long)]
        local: bool,
        #[arg(long)]
        canister_id: Option<String>,
        #[arg(long)]
        prefix: String,
        #[arg(long)]
        payload_size_bytes: usize,
        #[arg(long)]
        file_count: usize,
        #[arg(long, value_enum)]
        directory_shape: DirectoryShape,
        #[arg(long)]
        concurrent_clients: usize,
        #[arg(long, default_value_t = 100)]
        iterations: usize,
        #[arg(long, default_value_t = 3)]
        warmup_iterations: usize,
        #[arg(long, value_enum)]
        operation: WorkloadOperation,
        #[arg(long, value_enum, default_value_t = BenchSearchPreviewMode::None)]
        preview_mode: BenchSearchPreviewMode,
    },
    Latency {
        #[arg(long)]
        output_json: String,
        #[arg(long)]
        benchmark_name: String,
        #[arg(long)]
        local: bool,
        #[arg(long)]
        canister_id: Option<String>,
        #[arg(long)]
        prefix: String,
        #[arg(long)]
        payload_size_bytes: usize,
        #[arg(long, default_value_t = 1000)]
        iterations: usize,
        #[arg(long, default_value_t = 20)]
        warmup_iterations: usize,
        #[arg(long, value_enum)]
        operation: LatencyOperation,
    },
    WorkloadSetup {
        #[arg(long)]
        output_json: String,
        #[arg(long)]
        benchmark_name: String,
        #[arg(long)]
        local: bool,
        #[arg(long)]
        canister_id: Option<String>,
        #[arg(long)]
        prefix: String,
        #[arg(long)]
        payload_size_bytes: usize,
        #[arg(long)]
        file_count: usize,
        #[arg(long, value_enum)]
        directory_shape: DirectoryShape,
        #[arg(long)]
        concurrent_clients: usize,
        #[arg(long, default_value_t = 100)]
        iterations: usize,
        #[arg(long, value_enum)]
        operation: WorkloadOperation,
        #[arg(long, value_enum, default_value_t = BenchSearchPreviewMode::None)]
        preview_mode: BenchSearchPreviewMode,
    },
    WorkloadMeasure {
        #[arg(long)]
        output_json: String,
        #[arg(long)]
        benchmark_name: String,
        #[arg(long)]
        local: bool,
        #[arg(long)]
        canister_id: Option<String>,
        #[arg(long)]
        prefix: String,
        #[arg(long)]
        payload_size_bytes: usize,
        #[arg(long)]
        file_count: usize,
        #[arg(long, value_enum)]
        directory_shape: DirectoryShape,
        #[arg(long)]
        concurrent_clients: usize,
        #[arg(long, default_value_t = 100)]
        iterations: usize,
        #[arg(long, value_enum)]
        operation: WorkloadOperation,
        #[arg(long, value_enum, default_value_t = BenchSearchPreviewMode::None)]
        preview_mode: BenchSearchPreviewMode,
    },
    LatencySetup {
        #[arg(long)]
        output_json: String,
        #[arg(long)]
        benchmark_name: String,
        #[arg(long)]
        local: bool,
        #[arg(long)]
        canister_id: Option<String>,
        #[arg(long)]
        prefix: String,
        #[arg(long)]
        payload_size_bytes: usize,
        #[arg(long, value_enum)]
        operation: LatencyOperation,
    },
    LatencyMeasure {
        #[arg(long)]
        output_json: String,
        #[arg(long)]
        benchmark_name: String,
        #[arg(long)]
        local: bool,
        #[arg(long)]
        canister_id: Option<String>,
        #[arg(long)]
        prefix: String,
        #[arg(long)]
        payload_size_bytes: usize,
        #[arg(long, default_value_t = 1000)]
        iterations: usize,
        #[arg(long, value_enum)]
        operation: LatencyOperation,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    match Cli::parse().command {
        Command::Workload {
            output_json,
            benchmark_name,
            local,
            canister_id,
            prefix,
            payload_size_bytes,
            file_count,
            directory_shape,
            concurrent_clients,
            iterations,
            warmup_iterations,
            operation,
            preview_mode,
        } => {
            let connection = resolve_connection(local, canister_id)?;
            let result = run_workload_bench(WorkloadBenchArgs {
                benchmark_name,
                replica_host: connection.replica_host,
                canister_id: connection.canister_id,
                prefix,
                payload_size_bytes,
                file_count,
                directory_shape,
                concurrent_clients,
                iterations,
                warmup_iterations,
                operation,
                measurement_mode: MeasurementMode::ScenarioTotal,
                preview_mode: preview_mode.into(),
            })
            .await?;
            fs::write(output_json, serde_json::to_string_pretty(&result)? + "\n")?;
        }
        Command::Latency {
            output_json,
            benchmark_name,
            local,
            canister_id,
            prefix,
            payload_size_bytes,
            iterations,
            warmup_iterations,
            operation,
        } => {
            let connection = resolve_connection(local, canister_id)?;
            let result = run_latency_bench(LatencyBenchArgs {
                benchmark_name,
                replica_host: connection.replica_host,
                canister_id: connection.canister_id,
                prefix,
                payload_size_bytes,
                iterations,
                warmup_iterations,
                operation,
                measurement_mode: MeasurementMode::ScenarioTotal,
            })
            .await?;
            fs::write(output_json, serde_json::to_string_pretty(&result)? + "\n")?;
        }
        Command::WorkloadSetup {
            output_json,
            benchmark_name,
            local,
            canister_id,
            prefix,
            payload_size_bytes,
            file_count,
            directory_shape,
            concurrent_clients,
            iterations,
            operation,
            preview_mode,
        } => {
            let connection = resolve_connection(local, canister_id)?;
            write_setup(
                output_json,
                setup_workload_bench(WorkloadBenchArgs {
                    benchmark_name,
                    replica_host: connection.replica_host,
                    canister_id: connection.canister_id,
                    prefix,
                    payload_size_bytes,
                    file_count,
                    directory_shape,
                    concurrent_clients,
                    iterations,
                    warmup_iterations: 0,
                    operation,
                    measurement_mode: MeasurementMode::IsolatedSingleOp,
                    preview_mode: preview_mode.into(),
                })
                .await?,
            )?
        }
        Command::WorkloadMeasure {
            output_json,
            benchmark_name,
            local,
            canister_id,
            prefix,
            payload_size_bytes,
            file_count,
            directory_shape,
            concurrent_clients,
            iterations,
            operation,
            preview_mode,
        } => {
            let connection = resolve_connection(local, canister_id)?;
            let result = measure_workload_bench(WorkloadBenchArgs {
                benchmark_name,
                replica_host: connection.replica_host,
                canister_id: connection.canister_id,
                prefix,
                payload_size_bytes,
                file_count,
                directory_shape,
                concurrent_clients,
                iterations,
                warmup_iterations: 0,
                operation,
                measurement_mode: MeasurementMode::IsolatedSingleOp,
                preview_mode: preview_mode.into(),
            })
            .await?;
            fs::write(output_json, serde_json::to_string_pretty(&result)? + "\n")?;
        }
        Command::LatencySetup {
            output_json,
            benchmark_name,
            local,
            canister_id,
            prefix,
            payload_size_bytes,
            operation,
        } => {
            let connection = resolve_connection(local, canister_id)?;
            write_setup(
                output_json,
                setup_latency_bench(LatencyBenchArgs {
                    benchmark_name,
                    replica_host: connection.replica_host,
                    canister_id: connection.canister_id,
                    prefix,
                    payload_size_bytes,
                    iterations: 0,
                    warmup_iterations: 0,
                    operation,
                    measurement_mode: MeasurementMode::IsolatedSingleOp,
                })
                .await?,
            )?
        }
        Command::LatencyMeasure {
            output_json,
            benchmark_name,
            local,
            canister_id,
            prefix,
            payload_size_bytes,
            iterations,
            operation,
        } => {
            let connection = resolve_connection(local, canister_id)?;
            let result = measure_latency_bench(LatencyBenchArgs {
                benchmark_name,
                replica_host: connection.replica_host,
                canister_id: connection.canister_id,
                prefix,
                payload_size_bytes,
                iterations,
                warmup_iterations: 0,
                operation,
                measurement_mode: MeasurementMode::IsolatedSingleOp,
            })
            .await?;
            fs::write(output_json, serde_json::to_string_pretty(&result)? + "\n")?;
        }
    }
    Ok(())
}

fn write_setup(path: String, result: SetupStats) -> Result<()> {
    fs::write(path, serde_json::to_string_pretty(&result)? + "\n")?;
    Ok(())
}
