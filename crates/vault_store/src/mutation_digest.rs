//! Frozen schema-8 mutation identity. Extending the wire Action must not alter
//! the Candid type table hashed into previously retained operation receipts.
use super::*;
use candid::CandidType;

#[derive(CandidType)]
struct LegacyMutation<'a> {
    operation: &'a Id,
    action: LegacyAction<'a>,
}
// This exact variant set is permanent. New actions get independent domains and
// action-specific records, rather than the extensible Action wire enum.
#[derive(CandidType)]
enum LegacyAction<'a> {
    BeginRevision(LegacyBeginRevision<'a>),
    PutChunk {
        upload: &'a Id,
        index: u32,
        bytes: &'a Vec<u8>,
    },
    CommitRevision {
        upload: &'a Id,
    },
    DeleteObject {
        vault: &'a Id,
        object: &'a Id,
        expected_revision: u64,
    },
    PurgeObject {
        vault: &'a Id,
        object: &'a Id,
        expected_revision: u64,
    },
    CancelUpload {
        vault: &'a Id,
        upload: &'a Id,
        job: &'a Id,
    },
    DeleteVault {
        vault: &'a Id,
    },
    Collect,
}
#[derive(CandidType)]
struct LegacyBeginRevision<'a> {
    vault: &'a Id,
    object: &'a Id,
    expected_revision: u64,
    operation: &'a Id,
    plain_size: u64,
    manifest: &'a Vec<u8>,
    chunk_hashes: &'a Vec<Vec<u8>>,
}
#[derive(CandidType)]
struct InlineMutation<'a> {
    operation: &'a Id,
    request: &'a SaveInline,
}
pub fn mutation_digest(r: &Mutation) -> Result<Vec<u8>> {
    let action = match &r.action {
        Action::SaveInline(request) => {
            return operations::digest(
                b"save-inline/v1",
                &InlineMutation {
                    operation: &r.operation,
                    request,
                },
            );
        }
        Action::BeginRevision(r) => LegacyAction::BeginRevision(LegacyBeginRevision {
            vault: &r.vault,
            object: &r.object,
            expected_revision: r.expected_revision,
            operation: &r.operation,
            plain_size: r.plain_size,
            manifest: &r.manifest,
            chunk_hashes: &r.chunk_hashes,
        }),
        Action::PutChunk {
            upload,
            index,
            bytes,
        } => LegacyAction::PutChunk {
            upload,
            index: *index,
            bytes,
        },
        Action::CommitRevision { upload } => LegacyAction::CommitRevision { upload },
        Action::DeleteObject {
            vault,
            object,
            expected_revision,
        } => LegacyAction::DeleteObject {
            vault,
            object,
            expected_revision: *expected_revision,
        },
        Action::PurgeObject {
            vault,
            object,
            expected_revision,
        } => LegacyAction::PurgeObject {
            vault,
            object,
            expected_revision: *expected_revision,
        },
        Action::CancelUpload { vault, upload, job } => {
            LegacyAction::CancelUpload { vault, upload, job }
        }
        Action::DeleteVault { vault } => LegacyAction::DeleteVault { vault },
        Action::Collect => LegacyAction::Collect,
    };
    let request = LegacyMutation {
        operation: &r.operation,
        action,
    };
    operations::digest(b"mutation/v1", &request)
}
