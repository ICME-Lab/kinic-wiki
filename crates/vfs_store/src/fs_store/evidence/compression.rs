//! Bounded, lossless storage envelopes. Public evidence identities stay byte-exact.
use crate::evidence_codec::{EncodedEvidence, MAX_ENCODED_EVIDENCE_BYTES};
use base64::{Engine, engine::general_purpose::STANDARD};
use miniz_oxide::{deflate::compress_to_vec_zlib, inflate::decompress_to_vec_zlib_with_limit};
use serde::{Deserialize, Serialize};
const PREFIX: &str = "~kinic-zlib-v1:";

// Raw blobs are JSON spans (or a JSON event), so cannot start with this marker.
pub(super) fn pack_blob(raw: &str) -> String {
    if raw.len() > MAX_ENCODED_EVIDENCE_BYTES {
        return raw.into();
    }
    let compressed = compress_to_vec_zlib(raw.as_bytes(), 6);
    let packed = format!("{PREFIX}{}:{}", raw.len(), STANDARD.encode(compressed));
    if packed.len() < raw.len() {
        packed
    } else {
        raw.into()
    }
}
pub(super) fn unpack_blob(stored: &str) -> Result<String, String> {
    let Some(rest) = stored.strip_prefix(PREFIX) else {
        return Ok(stored.into());
    };
    let (len, data) = rest
        .split_once(':')
        .ok_or("invalid compressed evidence header")?;
    let len: usize = len
        .parse()
        .map_err(|_| "invalid compressed evidence length")?;
    if len > MAX_ENCODED_EVIDENCE_BYTES || data.len() > MAX_ENCODED_EVIDENCE_BYTES * 2 {
        return Err("compressed evidence exceeds output or input budget".into());
    }
    let compressed = STANDARD
        .decode(data)
        .map_err(|_| "invalid compressed evidence base64")?;
    let decoded = decompress_to_vec_zlib_with_limit(&compressed, len)
        .map_err(|_| "invalid or oversized compressed evidence")?;
    if decoded.len() != len {
        return Err("compressed evidence length mismatch".into());
    }
    String::from_utf8(decoded).map_err(|_| "compressed evidence is not UTF-8".into())
}
#[derive(Serialize, Deserialize)]
struct StoredManifest {
    storage_codec: String,
    original_len: u64,
    compressed_json: String,
}
pub(super) fn pack_manifest(manifest: &EncodedEvidence) -> Result<String, String> {
    let raw = serde_json::to_string(manifest).map_err(|e| e.to_string())?;
    let packed = pack_blob(&raw);
    if !packed.starts_with(PREFIX) {
        return Ok(raw);
    }
    let stored = serde_json::to_string(&StoredManifest {
        storage_codec: "zlib-v1".into(),
        original_len: manifest.original_len,
        compressed_json: packed,
    })
    .map_err(|e| e.to_string())?;
    Ok(if stored.len() < raw.len() {
        stored
    } else {
        raw
    })
}
pub(super) fn unpack_manifest(stored: &str) -> Result<EncodedEvidence, String> {
    // Keep old v1 manifests readable, including their former encoding budgets.
    let value: serde_json::Value = serde_json::from_str(stored).map_err(|e| e.to_string())?;
    if value.get("storage_codec").is_none() {
        return serde_json::from_value(value).map_err(|e| e.to_string());
    }
    let envelope: StoredManifest = serde_json::from_value(value).map_err(|e| e.to_string())?;
    if envelope.storage_codec != "zlib-v1" || !envelope.compressed_json.starts_with(PREFIX) {
        return Err("unsupported compressed evidence manifest".into());
    }
    let raw = unpack_blob(&envelope.compressed_json)?;
    let manifest: EncodedEvidence = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    if manifest.original_len != envelope.original_len {
        return Err("compressed manifest original length mismatch".into());
    }
    Ok(manifest)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn compressed_and_legacy_text_round_trip() {
        for raw in ["{}".to_owned(), "日本語 and whitespace ".repeat(4000)] {
            let packed = pack_blob(&raw);
            assert!(packed.len() <= raw.len());
            assert_eq!(unpack_blob(&packed).unwrap(), raw);
            assert_eq!(unpack_blob(&raw).unwrap(), raw);
        }
    }
    #[test]
    fn rejects_corruption_and_expansion_beyond_declared_budget() {
        let packed = pack_blob(&"repeat".repeat(1000));
        assert!(packed.starts_with(PREFIX));
        assert!(unpack_blob(&packed.replacen("6000:", "5:", 1)).is_err());
        for stored in [
            "~kinic-zlib-v1:2097153:AAAA",
            "~kinic-zlib-v1:4:!",
            "~kinic-zlib-v1:4:AAAA",
            "~kinic-zlib-v1:bad:AAAA",
        ] {
            assert!(unpack_blob(stored).is_err());
        }
    }
}
