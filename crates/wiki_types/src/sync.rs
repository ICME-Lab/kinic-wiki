// Where: crates/wiki_types/src/sync.rs
// What: Snapshot and sync DTOs for exporting, fetching, and committing wiki changes.
// Why: Local working copies need explicit contracts for clone/fetch/push-style workflows.
use candid::CandidType;
use serde::{Deserialize, Serialize};

use crate::WikiPageType;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct SectionHashEntry {
    pub section_path: String,
    pub content_hash: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct WikiPageSnapshot {
    pub page_id: String,
    pub slug: String,
    pub title: String,
    pub page_type: WikiPageType,
    pub revision_id: String,
    pub updated_at: i64,
    pub markdown: String,
    pub section_hashes: Vec<SectionHashEntry>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct SystemPageSnapshot {
    pub slug: String,
    pub markdown: String,
    pub updated_at: i64,
    pub etag: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct WikiSyncManifestEntry {
    pub page_id: String,
    pub slug: String,
    pub revision_id: String,
    pub updated_at: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct WikiSyncManifest {
    pub snapshot_revision: String,
    pub pages: Vec<WikiSyncManifestEntry>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct WikiSyncManifestDelta {
    pub upserted_pages: Vec<WikiSyncManifestEntry>,
    pub removed_page_ids: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct ExportWikiSnapshotRequest {
    pub include_system_pages: bool,
    pub page_slugs: Option<Vec<String>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct ExportWikiSnapshotResponse {
    pub snapshot_revision: String,
    pub pages: Vec<WikiPageSnapshot>,
    pub system_pages: Vec<SystemPageSnapshot>,
    pub manifest: WikiSyncManifest,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct KnownPageRevision {
    pub page_id: String,
    pub revision_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct FetchWikiUpdatesRequest {
    pub known_snapshot_revision: String,
    pub known_page_revisions: Vec<KnownPageRevision>,
    pub include_system_pages: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct FetchWikiUpdatesResponse {
    pub snapshot_revision: String,
    pub changed_pages: Vec<WikiPageSnapshot>,
    pub removed_page_ids: Vec<String>,
    pub system_pages: Vec<SystemPageSnapshot>,
    pub manifest_delta: WikiSyncManifestDelta,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct PageChangeInput {
    pub change_type: PageChangeType,
    pub page_id: String,
    pub base_revision_id: String,
    pub new_markdown: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub enum PageChangeType {
    Update,
    Delete,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct CommitWikiChangesRequest {
    pub base_snapshot_revision: String,
    pub page_changes: Vec<PageChangeInput>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct CommittedPageResult {
    pub page_id: String,
    pub revision_id: String,
    pub section_hashes: Vec<SectionHashEntry>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct RejectedPageResult {
    pub page_id: String,
    pub reason: String,
    pub conflicting_section_paths: Vec<String>,
    pub local_changed_section_paths: Vec<String>,
    pub remote_changed_section_paths: Vec<String>,
    pub conflict_markdown: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, CandidType)]
pub struct CommitWikiChangesResponse {
    pub committed_pages: Vec<CommittedPageResult>,
    pub rejected_pages: Vec<RejectedPageResult>,
    pub snapshot_revision: String,
    pub snapshot_was_stale: bool,
    pub system_pages: Vec<SystemPageSnapshot>,
    pub manifest_delta: WikiSyncManifestDelta,
}
