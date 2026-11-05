//! Frozen legacy evidence stays pending until the destination can store it compactly.
use super::model::Event;
use serde::Serialize;

pub const STORAGE_CAPABILITY: &str = "learning_evidence_storage_v1";
#[derive(Clone, Debug)]
pub struct DeliveryPolicy {
    pub evidence_storage_v1: bool,
    pub max_events: usize,
    pub max_bytes: usize,
}
impl Default for DeliveryPolicy {
    fn default() -> Self {
        Self {
            evidence_storage_v1: false,
            max_events: 32,
            max_bytes: 1_048_576,
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DeliveryDisposition {
    Eligible,
    Deferred { reason: String },
}
#[derive(Default, Debug, Serialize)]
pub struct DeliveryReport {
    pub sent: usize,
    pub deferred: usize,
    pub deferred_bytes: u64,
    pub budget_exhausted: bool,
}
pub fn classify(event: &Event, storage_v1: bool) -> DeliveryDisposition {
    let bytes = serde_json::to_vec(event).map_or(usize::MAX, |b| b.len());
    if event.kind == "hook"
        && event.payload["schema_version"] != 2
        && bytes > 16 * 1024
        && !storage_v1
    {
        let capture = event.payload.get("capture").unwrap_or(&event.payload);
        let reason = if capture.get("session_evidence").is_some() {
            "legacy_evidence_requires_shared_storage"
        } else {
            "legacy_large_hook_format_unknown"
        };
        DeliveryDisposition::Deferred {
            reason: reason.into(),
        }
    } else {
        DeliveryDisposition::Eligible
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn delivery_policy_boundary_and_modern_stop() {
        let mut e = Event {
            id: "e".into(),
            run_id: "r".into(),
            kind: "hook".into(),
            payload: serde_json::json!({"pad":""}),
        };
        let overhead = serde_json::to_vec(&e).unwrap().len();
        e.payload["pad"] = "x".repeat(16384 - overhead).into();
        assert_eq!(classify(&e, false), DeliveryDisposition::Eligible);
        e.payload["pad"] = "x".repeat(16385 - overhead).into();
        assert!(matches!(
            classify(&e, false),
            DeliveryDisposition::Deferred { .. }
        ));
        assert_eq!(classify(&e, true), DeliveryDisposition::Eligible);
        e.payload["schema_version"] = 2.into();
        e.payload["capture"] =
            serde_json::json!({"event":"Stop","session_evidence":{"records":[]}});
        assert_eq!(classify(&e, false), DeliveryDisposition::Eligible);
    }
}
