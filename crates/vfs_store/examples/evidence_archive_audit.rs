//! Read-only audit of verified preimages. Never prints paths or conversation content.
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::Path};
use vfs_store::evidence_codec::{EvidencePiece, decode_evidence, encode_evidence};
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let file = std::env::args_os()
        .nth(1)
        .ok_or("usage: evidence_archive_audit VERIFIED-MANIFEST.json")?;
    let file = Path::new(&file);
    let parent = file
        .parent()
        .ok_or("manifest parent missing")?
        .canonicalize()?;
    if std::fs::metadata(file)?.len() > 4 * 1024 * 1024 {
        return Err("manifest too large".into());
    }
    let bytes = std::fs::read(file)?;
    let manifest: Value = serde_json::from_slice(&bytes)?;
    let rows = manifest["rows"].as_array().ok_or("manifest rows missing")?;
    if rows.is_empty() || rows.len() > 10000 {
        return Err("manifest row count outside audit budget".into());
    }
    let mut original_bytes = 0u64;
    let mut encoded = 0u64;
    let mut manifests = 0u64;
    let mut untouched = 0u64;
    let mut shared: BTreeMap<(String, String), Vec<u8>> = BTreeMap::new();
    for row in rows {
        // Older manifests retain the old working-tree path. Use only its file name
        // in the selected backup directory, then verify the immutable file hash.
        let old = Path::new(row["backup_file"].as_str().ok_or("backup file missing")?);
        let path = parent
            .join(old.file_name().ok_or("backup file name missing")?)
            .canonicalize()?;
        if !path.starts_with(&parent) || !path.is_file() {
            return Err("backup escapes selected archive".into());
        }
        if std::fs::metadata(&path)?.len() > 8 * 1024 * 1024 {
            return Err("backup exceeds audit file budget".into());
        }
        let data = std::fs::read(path)?;
        if Some(hash(&data).as_str()) != row["backup_sha256"].as_str() {
            return Err("backup hash mismatch".into());
        }
        let node: Value = serde_json::from_slice(&data)?;
        if node["etag"] != row["etag"] {
            return Err("backup etag mismatch".into());
        }
        let body = node["content"].as_str().ok_or("node body missing")?;
        if row["bytes"].as_u64() != Some(body.len() as u64) {
            return Err("backup body byte count mismatch".into());
        }
        original_bytes += body.len() as u64;
        if original_bytes > 256 * 1024 * 1024 {
            return Err("archive exceeds audit total budget".into());
        }
        if let Some((e, blobs)) = encode_evidence(
            node["path"].as_str().ok_or("node path missing")?,
            node["metadata_json"].as_str().ok_or("metadata missing")?,
            body,
        )? {
            let blobs: BTreeMap<_, _> = blobs.into_iter().collect();
            let rebuilt = decode_evidence(&e, |_, sha| {
                blobs
                    .get(sha)
                    .cloned()
                    .ok_or_else(|| "missing audit blob".into())
            })?;
            if rebuilt != body || hash(rebuilt.as_bytes()) != hash(body.as_bytes()) {
                return Err("archive reconstruction mismatch".into());
            }
            manifests += serde_json::to_vec(&e)?.len() as u64;
            for piece in &e.pieces {
                if let EvidencePiece::Blob { run_id, sha256, .. } = piece {
                    let value = blobs.get(sha256).ok_or("audit blob missing")?;
                    if let Some(previous) =
                        shared.insert((run_id.clone(), sha256.clone()), value.clone())
                        && previous != *value
                    {
                        return Err("audit shared hash collision".into());
                    }
                }
            }
            encoded += 1;
        } else {
            untouched += body.len() as u64;
        }
    }
    println!(
        "{}",
        serde_json::to_string_pretty(&serde_json::json!({
            "scope":"selected verified archive subset; codec payload estimates, not complete database size",
            "complete_database_coverage":false,"read_only":true,"manifest_sha256":hash(&bytes),
            "verified_records":rows.len(),"shared_codec_records":encoded,"original_body_bytes":original_bytes,
            "manifest_bytes":manifests,"unique_record_bytes":shared.values().map(|v|v.len() as u64).sum::<u64>(),
            "unchanged_body_bytes":untouched,"historical_deleted_records_coverage":"unknown","fts_bytes":null,"stable_physical_bytes":null
        }))?
    );
    Ok(())
}
