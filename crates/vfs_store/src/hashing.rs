// Where: crates/vfs_store/src/hashing.rs
// What: Minimal hashing helpers shared by the FS-first store.
// Why: Node etags and snapshot revisions need one deterministic SHA-256 encoder.
use sha2::{Digest, Sha256};

pub fn sha256_hex(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    format!("{:x}", hasher.finalize())
}
