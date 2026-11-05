//! Internal lossless representation of immutable learning evidence.
//! Only exact raw JSON spans are shared; whitespace and duplicate keys survive.
use crate::hashing::sha256_hex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, value::RawValue};
use std::collections::BTreeMap;

pub const MAX_EVIDENCE_BYTES: usize = 2 * 1024 * 1024;
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EncodedEvidence {
    pub version: u32,
    pub original_sha256: String,
    pub original_len: u64,
    pub pieces: Vec<EvidencePiece>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum EvidencePiece {
    Inline(Vec<u8>),
    Blob {
        run_id: String,
        sha256: String,
        len: u64,
    },
}
pub type EvidenceBlobs = Vec<(String, Vec<u8>)>;

fn field<'a>(object: &'a str, key: &str) -> Option<&'a RawValue> {
    let values: BTreeMap<&str, &RawValue> = serde_json::from_str(object).ok()?;
    values.get(key).copied()
}
fn text_field(object: &str, key: &str) -> Option<String> {
    serde_json::from_str(field(object, key)?.get()).ok()
}

pub fn encode_evidence(
    path: &str,
    metadata: &str,
    body: &str,
) -> Result<Option<(EncodedEvidence, EvidenceBlobs)>, String> {
    if body.len() > MAX_EVIDENCE_BYTES {
        return Ok(None);
    }
    let Ok(meta) = serde_json::from_str::<Value>(metadata) else {
        return Ok(None);
    };
    if meta["kind"] != "kinic.learning.evidence"
        || ["protected", "approved", "approved_decision"]
            .iter()
            .any(|k| meta[k] == true)
    {
        return Ok(None);
    }
    let Some(run) = text_field(body, "run_id").filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    let Some(id) = text_field(body, "id").filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    if text_field(body, "kind").as_deref() != Some("hook")
        || path
            != format!(
                "/Sources/learning-runs/{}/{}.json",
                sha256_hex(&run),
                sha256_hex(&id)
            )
    {
        return Ok(None);
    }
    let records = field(body, "payload")
        .and_then(|p| field(p.get(), "capture").or(Some(p)))
        .and_then(|c| field(c.get(), "session_evidence"))
        .and_then(|e| field(e.get(), "records"))
        .and_then(|r| serde_json::from_str::<Vec<&RawValue>>(r.get()).ok());
    let Some(records) = records else {
        return Ok(None);
    };
    let mut pieces = Vec::new();
    let mut blobs = BTreeMap::new();
    let mut cursor = 0;
    for record in records {
        let raw = record.get();
        let offset = (raw.as_ptr() as usize)
            .checked_sub(body.as_ptr() as usize)
            .ok_or("invalid evidence span")?;
        let end = offset
            .checked_add(raw.len())
            .ok_or("invalid evidence span")?;
        if offset < cursor || end > body.len() || body.get(offset..end) != Some(raw) {
            return Err("invalid evidence span".into());
        }
        if offset > cursor {
            pieces.push(EvidencePiece::Inline(
                body.as_bytes()[cursor..offset].to_vec(),
            ));
        }
        let sha = sha256_hex(raw);
        if let Some(prior) = blobs.insert(sha.clone(), raw.as_bytes().to_vec())
            && prior != raw.as_bytes()
        {
            return Err("evidence hash collision".into());
        }
        pieces.push(EvidencePiece::Blob {
            run_id: run.clone(),
            sha256: sha,
            len: raw.len() as u64,
        });
        cursor = end;
    }
    if cursor < body.len() {
        pieces.push(EvidencePiece::Inline(body.as_bytes()[cursor..].to_vec()));
    }
    Ok(Some((
        EncodedEvidence {
            version: 1,
            original_sha256: sha256_hex(body),
            original_len: body.len() as u64,
            pieces,
        },
        blobs.into_iter().collect(),
    )))
}

pub fn decode_evidence(
    manifest: &EncodedEvidence,
    mut fetch: impl FnMut(&str, &str) -> Result<Vec<u8>, String>,
) -> Result<String, String> {
    if manifest.version != 1
        || manifest.original_len > MAX_EVIDENCE_BYTES as u64
        || manifest.pieces.len() > MAX_EVIDENCE_BYTES
    {
        return Err("unsupported or oversized evidence manifest".into());
    }
    let mut body = Vec::with_capacity(manifest.original_len as usize);
    for piece in &manifest.pieces {
        let bytes = match piece {
            EvidencePiece::Inline(b) => b.clone(),
            EvidencePiece::Blob {
                run_id,
                sha256,
                len,
            } => {
                if *len > manifest.original_len {
                    return Err("evidence blob length exceeds original".into());
                }
                let b = fetch(run_id, sha256)?;
                if b.len() as u64 != *len
                    || std::str::from_utf8(&b).map(sha256_hex).ok().as_ref() != Some(sha256)
                {
                    return Err("evidence blob hash or length mismatch".into());
                }
                b
            }
        };
        if body.len().saturating_add(bytes.len()) > manifest.original_len as usize {
            return Err("evidence reconstruction exceeds original length".into());
        }
        body.extend_from_slice(&bytes);
    }
    let body = String::from_utf8(body).map_err(|_| "evidence is not UTF-8")?;
    if body.len() as u64 != manifest.original_len || sha256_hex(&body) != manifest.original_sha256 {
        return Err("evidence reconstruction hash mismatch".into());
    }
    Ok(body)
}
