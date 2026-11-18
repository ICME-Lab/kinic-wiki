//! Read compatibility for the interim ten-variant journal hash protocol.
//! Canonical writes use the store's frozen/action-specific mutation identities.
//! Candid includes unused variants too: never extend the historical enum here.
//! Borrow fields so compatibility checks do not clone uploaded chunks.
use super::*;
use candid::CandidType;

#[derive(CandidType)]
struct Request<A: CandidType> {
    operation: Id,
    action: A,
}

// Freeze nested record shapes too; the public BeginRevision may evolve later.
#[derive(CandidType)]
struct Begin<'a> {
    vault: &'a Id,
    object: &'a Id,
    operation: &'a Id,
    expected_revision: u64,
    plain_size: u64,
    manifest: &'a Vec<u8>,
    chunk_hashes: &'a Vec<Vec<u8>>,
}
impl<'a> From<&'a BeginRevision> for Begin<'a> {
    fn from(r: &'a BeginRevision) -> Self {
        // Exhaustive patterns force an explicit hash-version decision if the
        // public request gains a field; silently dropping it would weaken replay.
        let BeginRevision {
            vault,
            object,
            operation,
            expected_revision,
            plain_size,
            manifest,
            chunk_hashes,
        } = r;
        Self {
            vault,
            object,
            operation,
            expected_revision: *expected_revision,
            plain_size: *plain_size,
            manifest,
            chunk_hashes,
        }
    }
}

// Read compatibility for the already-deployed ten-variant implementation.
// New writes never use this whole-enum hash. Do not add future variants here.
#[derive(CandidType)]
enum Interim<'a> {
    BeginRevision(Begin<'a>),
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
    RenameVault {
        vault: &'a Id,
        name: &'a str,
        expected_sequence: u64,
    },
}
impl<'a> Interim<'a> {
    fn from_action(action: &'a Action) -> Option<Self> {
        Some(match action {
            Action::BeginRevision(r) => Self::BeginRevision(r.into()),
            Action::PutChunk {
                upload,
                index,
                bytes,
            } => Self::PutChunk {
                upload,
                index: *index,
                bytes,
            },
            Action::CommitRevision { upload } => Self::CommitRevision { upload },
            Action::DeleteObject {
                vault,
                object,
                expected_revision,
            } => Self::DeleteObject {
                vault,
                object,
                expected_revision: *expected_revision,
            },
            Action::PurgeObject {
                vault,
                object,
                expected_revision,
            } => Self::PurgeObject {
                vault,
                object,
                expected_revision: *expected_revision,
            },
            Action::CancelUpload { vault, upload, job } => {
                Self::CancelUpload { vault, upload, job }
            }
            Action::DeleteVault { vault } => Self::DeleteVault { vault },
            Action::Collect => Self::Collect,
            Action::SaveInline(_) => return None,
            Action::RenameVault {
                vault,
                name,
                expected_sequence,
            } => Self::RenameVault {
                vault,
                name,
                expected_sequence: *expected_sequence,
            },
        })
    }
}

pub(super) fn resolve(db: &sql::Connection, r: &Mutation) -> Result<Vec<u8>> {
    let canonical = ops::mutation_digest(r)?;
    let stored: Option<Vec<u8>> = db.query_row(
        "SELECT digest FROM operations WHERE owner=(SELECT owner FROM owner_scope WHERE slot=1) AND operation=?1",
        params![r.operation], |row| sql::row_get(row, 0),
    ).optional().map_err(|_| Error::Storage)?;
    match stored {
        None => Ok(canonical),
        Some(stored) if stored == canonical => Ok(stored),
        Some(stored) => {
            let Some(action) = Interim::from_action(&r.action) else {
                return Err(Error::Conflict);
            };
            let interim = ops::digest(
                b"mutation/v1",
                &Request {
                    operation: r.operation.clone(),
                    action,
                },
            )?;
            if stored == interim {
                Ok(stored)
            } else {
                Err(Error::Conflict)
            }
        }
    }
}
