//! Internal lossless representation of immutable learning evidence.
//! Only exact raw JSON spans are shared; whitespace and duplicate keys survive.
use crate::hashing::sha256_hex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, value::RawValue};
use std::collections::BTreeMap;

pub const MAX_EVIDENCE_BYTES: usize = 2 * 1024 * 1024;
/// Serialized manifest plus unique raw blob bytes; excludes SQLite page/index overhead.
pub const MAX_ENCODED_EVIDENCE_BYTES: usize = 2 * 1024 * 1024;

// Count serialization without allocating the output or continuing beyond its budget.
fn json_bytes(value: &impl Serialize, limit: usize) -> Result<Option<usize>, String> {
    struct Counter {
        written: usize,
        limit: usize,
        exceeded: bool,
    }
    impl std::io::Write for Counter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            let Some(next) = self
                .written
                .checked_add(bytes.len())
                .filter(|n| *n <= self.limit)
            else {
                self.exceeded = true;
                return Err(std::io::Error::other("evidence encoding budget exceeded"));
            };
            self.written = next;
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut counter = Counter {
        written: 0,
        limit,
        exceeded: false,
    };
    match serde_json::to_writer(&mut counter, value) {
        Ok(()) => Ok(Some(counter.written)),
        Err(_) if counter.exceeded => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}
fn whole_body(
    run: &str,
    body: &str,
    sha: &str,
) -> Result<Option<(EncodedEvidence, EvidenceBlobs)>, String> {
    let manifest = EncodedEvidence {
        version: 1,
        original_sha256: sha.into(),
        original_len: body.len() as u64,
        pieces: vec![EvidencePiece::Blob {
            run_id: run.into(),
            sha256: sha.into(),
            len: body.len() as u64,
        }],
    };
    let remaining = MAX_ENCODED_EVIDENCE_BYTES.saturating_sub(body.len());
    if json_bytes(&manifest, remaining)?.is_none() {
        return Ok(None);
    }
    Ok(Some((
        manifest,
        vec![(sha.into(), body.as_bytes().to_vec())],
    )))
}
struct PieceBudget {
    manifest: usize,
    blobs: usize,
    parts: usize,
    manifest_limit: usize,
}
impl PieceBudget {
    fn reserve(&mut self, piece: &EvidencePiece, new_blob: usize) -> Result<bool, String> {
        let blobs = self
            .blobs
            .checked_add(new_blob)
            .ok_or("evidence byte count overflow")?;
        let limit = self
            .manifest_limit
            .min(MAX_ENCODED_EVIDENCE_BYTES.saturating_sub(blobs));
        let used = self
            .manifest
            .checked_add(usize::from(self.parts > 0))
            .ok_or("evidence byte count overflow")?;
        let Some(remaining) = limit.checked_sub(used) else {
            return Ok(false);
        };
        let Some(bytes) = json_bytes(piece, remaining)? else {
            return Ok(false);
        };
        self.manifest = used + bytes;
        self.blobs = blobs;
        self.parts += 1;
        Ok(true)
    }
}
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
    let sha = sha256_hex(body);
    if let Some(encoded) = record_pieces(&run, body, records, &sha)? {
        return Ok(Some(encoded));
    }
    whole_body(&run, body, &sha)
}
fn record_pieces(
    run: &str,
    body: &str,
    records: Vec<&RawValue>,
    sha: &str,
) -> Result<Option<(EncodedEvidence, EvidenceBlobs)>, String> {
    let empty = EncodedEvidence {
        version: 1,
        original_sha256: sha.into(),
        original_len: body.len() as u64,
        pieces: vec![],
    };
    let Some(header) = json_bytes(&empty, body.len())? else {
        return Ok(None);
    };
    let mut budget = PieceBudget {
        manifest: header,
        blobs: 0,
        parts: 0,
        manifest_limit: body.len(),
    };
    let mut pieces = Vec::new();
    let mut blobs: BTreeMap<String, Vec<u8>> = BTreeMap::new();
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
            let piece = EvidencePiece::Inline(body.as_bytes()[cursor..offset].to_vec());
            if !budget.reserve(&piece, 0)? {
                return Ok(None);
            }
            pieces.push(piece);
        }
        let sha = sha256_hex(raw);
        let new_blob = match blobs.get(&sha) {
            Some(prior) if prior.as_slice() != raw.as_bytes() => {
                return Err("evidence hash collision".into());
            }
            Some(_) => 0,
            None => raw.len(),
        };
        // At most one prospective piece is allocated before reserve; retained pieces
        // are bounded by the original body, including repeated run identifiers.
        let piece = EvidencePiece::Blob {
            run_id: run.into(),
            sha256: sha.clone(),
            len: raw.len() as u64,
        };
        if !budget.reserve(&piece, new_blob)? {
            return Ok(None);
        }
        if new_blob > 0 {
            blobs.insert(sha, raw.as_bytes().to_vec());
        }
        pieces.push(piece);
        cursor = end;
    }
    if cursor < body.len() {
        let piece = EvidencePiece::Inline(body.as_bytes()[cursor..].to_vec());
        if !budget.reserve(&piece, 0)? {
            return Ok(None);
        }
        pieces.push(piece);
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
