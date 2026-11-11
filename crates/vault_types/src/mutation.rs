//! Exact Candid wire protocol. The signature covers DOMAIN || received payload, never a reserialization.
use super::*;
pub const MUTATION_DOMAIN: &[u8] = b"kinic-vault/mutation/v2\0";
pub const MUTATION_MAX: usize = CHUNK_MAX + 131072;
pub const CLEANUP_MUTATION_MAX: usize = 8192;
pub const CLEANUP_SLOT_BYTES: u64 = 65536;
pub const WRAPPER_HEADROOM: u64 = 2 * 2048;
#[derive(CandidType, Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub enum CredentialScope {
    Global,
    Instances(Vec<Instance>),
}
#[derive(CandidType, Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct Instance {
    pub vault: Id,
    pub nonce: Vec<u8>,
}
#[derive(CandidType, Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub enum GrantPurpose {
    Normal,
    Credentials,
    Create,
    Restore { job: Id },
    Incident { job: Id },
    Cleanup { job: Id },
}
#[derive(CandidType, Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct GrantRequest {
    pub operation: Id,
    pub public_key: Vec<u8>,
    pub credential: Vec<u8>,
    pub purpose: GrantPurpose,
    pub generations: Vec<Generation>,
}
#[derive(CandidType, Serialize, Deserialize, Debug, Clone)]
pub struct GrantInfo {
    pub id: Id,
    pub expires: u64,
    pub next_counter: u64,
    pub purpose: GrantPurpose,
    pub generations: Vec<Generation>,
}
#[derive(CandidType, Serialize, Deserialize, Debug, Clone)]
pub struct Bootstrap {
    pub reserve: Reserve,
    pub public_key: Vec<u8>,
}
#[derive(CandidType, Serialize, Deserialize, Debug, Clone)]
pub struct BootstrapReply {
    pub header: Header,
    pub challenge: Challenge,
}
#[derive(CandidType, Serialize, Deserialize, Debug, Clone)]
pub struct Mutation {
    pub version: u8,
    pub canister: Principal,
    pub owner: Principal,
    pub grant: Id,
    pub counter: u64,
    pub operation: MutationOperation,
}
#[derive(CandidType, Serialize, Deserialize, Debug, Clone)]
pub enum MutationOperation {
    Create(Reserve),
    Activate {
        request: Activate,
        recovery_verifier: Vec<u8>,
    },
    Derive(Derive),
    KeyResult {
        handle: Id,
    },
    BeginRevision(BeginRevision),
    PutChunk {
        vault: Id,
        upload: Id,
        index: u32,
        data: Vec<u8>,
    },
    CommitRevision {
        vault: Id,
        upload: Id,
    },
    DeleteObject {
        vault: Id,
        object: Id,
        expected_revision: u64,
        operation: Id,
    },
    PurgeObject {
        vault: Id,
        object: Id,
    },
    RemoveCredential {
        credential: Vec<u8>,
    },
    BeginRegistration {
        vault: Id,
        scope: CredentialScope,
    },
    RegisterCredential {
        vault: Id,
        registration: String,
        scope: CredentialScope,
    },
    CancelSetup {
        vault: Id,
        attempt: Id,
    },
    Cleanup {
        job: Id,
        cursor: u64,
        action: CleanupAction,
    },
}
#[derive(CandidType, Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub enum CleanupAction {
    Expired,
    Purge,
    CancelSetup { attempt: Id },
    AbortExport { export: Id },
}
#[derive(CandidType, Serialize, Deserialize, Debug, Clone)]
pub enum MutationResult {
    Unit,
    Challenge(Challenge),
    Header(Header),
    Upload(Upload),
    Revision(Revision),
    Handle(Id),
    Key(KeyReply),
    Cleanup(CleanupProgress),
}
#[derive(CandidType, Serialize, Deserialize, Debug, Clone)]
pub struct CleanupProgress {
    pub job: Id,
    pub cursor: u64,
    pub complete: bool,
}

#[cfg(test)]
mod contract {
    #[test]
    fn mutation_contract_matches() {
        use candid::types::{Function, TypeInner, internal::TypeContainer};
        let mut c = TypeContainer::new();
        let t = c.add::<super::Mutation>();
        let actor = TypeInner::Service(vec![(
            "encode".into(),
            TypeInner::Func(Function {
                args: vec![t],
                rets: vec![],
                modes: vec![],
            })
            .into(),
        )])
        .into();
        let text = candid::pretty::candid::compile(&c.env, &Some(actor));
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/mutation.did");
        if std::env::var_os("WRITE_VAULT_DID").is_some() {
            std::fs::write(path, text).unwrap();
        } else {
            assert_eq!(std::fs::read_to_string(path).unwrap(), text);
        }
    }
}
