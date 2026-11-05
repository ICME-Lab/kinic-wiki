//! Evidence reconstruction is byte-exact, including representation differences.
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use vfs_store::evidence_codec::{decode_evidence, encode_evidence};
fn sha(b: &[u8]) -> String {
    format!("{:x}", Sha256::digest(b))
}
fn fixture(run: &str) -> (String, String) {
    // Substantial repeated records should still use record-level sharing; tiny
    // records now use one whole-body blob instead of an oversized descriptor list.
    let pad = "x".repeat(2000);
    let body = format!(
        r#"{{ "id":"event", "run_id":"{run}", "kind":"hook", "payload":{{"capture":{{"event":"PostToolUse","session_evidence":{{"records":[ {{ "text":"a\\nb", "dup":1,"dup":2, "pad":"{pad}" }},{{"unicode":"\\u65e5"}}, {{ "text":"a\\nb", "dup":1,"dup":2, "pad":"{pad}" }} ]}}}}}} }}"#
    );
    let path = format!(
        "/Sources/learning-runs/{}/{}.json",
        sha(run.as_bytes()),
        sha(b"event")
    );
    (path, body)
}
#[test]
fn codec_reconstructs_exact_raw_json() {
    let (path, body) = fixture("run");
    let (encoded, blobs) = encode_evidence(&path, r#"{"kind":"kinic.learning.evidence"}"#, &body)
        .unwrap()
        .unwrap();
    let blobs: BTreeMap<_, _> = blobs.into_iter().collect();
    let restored = decode_evidence(&encoded, |_, hash| {
        blobs.get(hash).cloned().ok_or("missing".into())
    })
    .unwrap();
    assert_eq!(restored, body);
    assert_eq!(encoded.original_sha256, sha(body.as_bytes()));
    assert_eq!(blobs.len(), 2);
    assert_eq!(encoded.original_len, body.len() as u64);
}
#[test]
fn codec_rejects_missing_corrupt_or_oversized_blob() {
    let (path, body) = fixture("run");
    let (encoded, blobs) = encode_evidence(&path, r#"{"kind":"kinic.learning.evidence"}"#, &body)
        .unwrap()
        .unwrap();
    assert!(decode_evidence(&encoded, |_, _| Err("missing".into())).is_err());
    assert!(decode_evidence(&encoded, |_, _| Ok(b"corrupt".to_vec())).is_err());
    let map: BTreeMap<_, _> = blobs.into_iter().collect();
    let mut invalid = encoded.clone();
    invalid.original_len = 1;
    assert!(decode_evidence(&invalid, |_, h| Ok(map[h].clone())).is_err());
    assert!(
        encode_evidence(
            "/Knowledge/case.md",
            r#"{"kind":"kinic.learning.evidence"}"#,
            &body
        )
        .unwrap()
        .is_none()
    );
    assert!(encode_evidence(&path, "{}", &body).unwrap().is_none());
    assert!(
        encode_evidence(&path, r#"{"kind":"kinic.learning.evidence"}"#, "not json")
            .unwrap()
            .is_none()
    );
}

#[test]
fn codec_shares_exact_records_only_and_keeps_run_scopes() {
    use vfs_store::evidence_codec::EvidencePiece;
    let (path, body) = fixture("first");
    let (a, _) = encode_evidence(&path, r#"{"kind":"kinic.learning.evidence"}"#, &body)
        .unwrap()
        .unwrap();
    let (path, body) = fixture("second");
    let (b, _) = encode_evidence(&path, r#"{"kind":"kinic.learning.evidence"}"#, &body)
        .unwrap()
        .unwrap();
    let runs = |e: &vfs_store::evidence_codec::EncodedEvidence| {
        e.pieces
            .iter()
            .filter_map(|p| match p {
                EvidencePiece::Blob { run_id, .. } => Some(run_id.clone()),
                _ => None,
            })
            .collect::<Vec<_>>()
    };
    assert_eq!(runs(&a), vec!["first", "first", "first"]);
    assert_eq!(runs(&b), vec!["second", "second", "second"]);
    // Twenty snapshots repeat one substantial raw JSON record without normalizing it.
    let record = format!(r#"{{ "text":"{}" }}"#, "x".repeat(20_000));
    let mut original = 0;
    let mut manifests = 0;
    let mut shared = BTreeMap::new();
    for n in 0..20 {
        let body = format!(
            r#"{{"id":"e{n}","run_id":"r","kind":"hook","payload":{{"capture":{{"session_evidence":{{"records":[{record}]}}}}}}}}"#
        );
        let path = format!(
            "/Sources/learning-runs/{}/{}.json",
            sha(b"r"),
            sha(format!("e{n}").as_bytes())
        );
        let (e, blobs) = encode_evidence(&path, r#"{"kind":"kinic.learning.evidence"}"#, &body)
            .unwrap()
            .unwrap();
        original += body.len();
        manifests += serde_json::to_vec(&e).unwrap().len();
        shared.extend(blobs);
    }
    assert_eq!(shared.len(), 1);
    assert!(manifests + shared.values().map(Vec::len).sum::<usize>() < original / 2);
}

#[test]
fn codec_bounds_short_records_and_long_run_identifiers() {
    for (run, records) in [
        (
            "r".repeat(112),
            vec![serde_json::json!({"type":"message","role":"assistant","content":"ok"}); 10_000],
        ),
        ("r".repeat(10_000), vec![serde_json::Value::Null; 1_000]),
    ] {
        let body=serde_json::json!({"id":"event","run_id":run,"kind":"hook","payload":{"schema_version":2,"capture":{"event":"Stop","session_evidence":{"records":records}}}}).to_string();
        let (path, _) = fixture(&run);
        let (manifest, blobs) =
            encode_evidence(&path, r#"{"kind":"kinic.learning.evidence"}"#, &body)
                .unwrap()
                .unwrap();
        let manifest_bytes = serde_json::to_vec(&manifest).unwrap().len();
        let total = manifest_bytes + blobs.iter().map(|(_, b)| b.len()).sum::<usize>();
        assert!(
            total <= body.len() * 2 + 512,
            "input={} encoded={total}",
            body.len()
        );
        assert!(total <= 2 * 1024 * 1024);
        let map: BTreeMap<_, _> = blobs.into_iter().collect();
        assert_eq!(
            decode_evidence(&manifest, |_, h| Ok(map[h].clone())).unwrap(),
            body
        );
    }
}
#[test]
fn codec_leaves_near_limit_inline_body_untransformed() {
    let (path, _) = fixture("run");
    let mut value = serde_json::json!({"id":"event","run_id":"run","kind":"hook","payload":{"capture":{"padding":"","session_evidence":{"records":[]}}}});
    let overhead = value.to_string().len();
    value["payload"]["capture"]["padding"] = "x".repeat(2 * 1024 * 1024 - 128 - overhead).into();
    let body = value.to_string();
    assert_eq!(body.len(), 2 * 1024 * 1024 - 128);
    assert!(
        encode_evidence(&path, r#"{"kind":"kinic.learning.evidence"}"#, &body)
            .unwrap()
            .is_none()
    );
}

#[test]
fn very_long_run_and_many_records_use_bounded_whole_body_fallback() {
    use vfs_store::evidence_codec::{EvidencePiece, MAX_ENCODED_EVIDENCE_BYTES};
    let run = "r".repeat(100_000);
    let body=serde_json::json!({"id":"event","run_id":run,"kind":"hook","payload":{"capture":{"session_evidence":{"records":vec![serde_json::Value::Null;10_000]}}}}).to_string();
    let path = format!(
        "/Sources/learning-runs/{}/{}.json",
        sha(run.as_bytes()),
        sha(b"event")
    );
    let (manifest, blobs) = encode_evidence(&path, r#"{"kind":"kinic.learning.evidence"}"#, &body)
        .unwrap()
        .unwrap();
    assert_eq!(manifest.pieces.len(), 1);
    assert!(
        matches!(&manifest.pieces[0],EvidencePiece::Blob{sha256,..} if sha256==&sha(body.as_bytes()))
    );
    assert_eq!(blobs.len(), 1);
    assert!(
        serde_json::to_vec(&manifest).unwrap().len() + blobs[0].1.len()
            <= MAX_ENCODED_EVIDENCE_BYTES
    );
    assert_eq!(
        decode_evidence(&manifest, |_, _| Ok(blobs[0].1.clone())).unwrap(),
        body
    );
}
