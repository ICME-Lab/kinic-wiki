//! Evidence reconstruction is byte-exact, including representation differences.
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use vfs_store::evidence_codec::{decode_evidence, encode_evidence};
fn sha(b: &[u8]) -> String {
    format!("{:x}", Sha256::digest(b))
}
fn fixture(run: &str) -> (String, String) {
    let body = format!(
        r#"{{ "id":"event", "run_id":"{run}", "kind":"hook", "payload":{{"capture":{{"event":"PostToolUse","session_evidence":{{"records":[ {{ "text":"a\\nb", "dup":1,"dup":2 }},{{"unicode":"\\u65e5"}}, {{ "text":"a\\nb", "dup":1,"dup":2 }} ]}}}}}} }}"#
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
