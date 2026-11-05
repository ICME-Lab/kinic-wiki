//! Explicit controller operations; no loop, inferred state hash, purchase or automatic retry.
use crate::cli::{EvidenceRebuildCommand, EvidenceRebuildControlArgs, EvidenceRebuildStepArgs};
use anyhow::Result;
use vfs_client::VfsApi;
use vfs_types::{
    EvidenceRebuildControlRequest, EvidenceRebuildRequest, EvidenceRebuildStepRequest,
};
fn step(a: EvidenceRebuildStepArgs) -> EvidenceRebuildStepRequest {
    EvidenceRebuildStepRequest {
        database_id: a.database_id,
        migration_id: a.migration_id,
        expected_step: a.expected_step,
        max_rows: a.max_rows,
        max_bytes: a.max_bytes,
    }
}
fn control(a: EvidenceRebuildControlArgs) -> EvidenceRebuildControlRequest {
    EvidenceRebuildControlRequest {
        database_id: a.database_id,
        migration_id: a.migration_id,
        expected_state_hash: a.expected_state_hash,
    }
}
pub(super) async fn run(client: &impl VfsApi, command: EvidenceRebuildCommand) -> Result<()> {
    let status = match command {
        EvidenceRebuildCommand::Preview { database_id } => {
            client.evidence_rebuild_status(&database_id).await?
        }
        EvidenceRebuildCommand::Begin {
            database_id,
            expected_source_mount,
            expected_schema,
        } => {
            client
                .evidence_rebuild_begin(EvidenceRebuildRequest {
                    database_id,
                    expected_source_mount,
                    expected_schema,
                })
                .await?
        }
        EvidenceRebuildCommand::Step { args } => client.evidence_rebuild_step(step(args)).await?,
        EvidenceRebuildCommand::Verify { args } => {
            client.evidence_rebuild_verify(step(args)).await?
        }
        EvidenceRebuildCommand::Activate { args } => {
            client.evidence_rebuild_activate(control(args)).await?
        }
        EvidenceRebuildCommand::Rollback { args } => {
            client.evidence_rebuild_rollback(control(args)).await?
        }
        EvidenceRebuildCommand::ResumeWrites { args } => {
            client.evidence_rebuild_resume_writes(control(args)).await?
        }
    };
    println!("{}", serde_json::to_string_pretty(&status)?);
    Ok(())
}
