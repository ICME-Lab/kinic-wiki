// Where: plugins/kinic-wiki/types.ts
// What: Runtime-safe plugin DTOs and validators for the mirror workflow.
// Why: The plugin consumes JSON from HTTP endpoints and persists local settings/state.
export type PluginPageType =
  | "entity"
  | "concept"
  | "overview"
  | "comparison"
  | "query_note"
  | "source_summary";

export interface PluginSettings {
  replicaHost: string;
  canisterId: string;
  mirrorRoot: string;
  autoPullOnStartup: boolean;
  openIndexAfterInitialSync: boolean;
  lastSnapshotRevision: string;
  lastSyncedAt: number;
}

export interface SectionHashEntry {
  section_path: string;
  content_hash: string;
}

export interface WikiPageSnapshot {
  page_id: string;
  slug: string;
  title: string;
  page_type: PluginPageType;
  revision_id: string;
  updated_at: number;
  markdown: string;
  section_hashes: SectionHashEntry[];
}

export interface SystemPageSnapshot {
  slug: string;
  markdown: string;
  updated_at: number;
  etag: string;
}

export interface WikiSyncManifestEntry {
  page_id: string;
  slug: string;
  revision_id: string;
  updated_at: number;
}

export interface ExportWikiSnapshotResponse {
  snapshot_revision: string;
  pages: WikiPageSnapshot[];
  system_pages: SystemPageSnapshot[];
}

export interface FetchWikiUpdatesResponse {
  snapshot_revision: string;
  changed_pages: WikiPageSnapshot[];
  removed_page_ids: string[];
  system_pages: SystemPageSnapshot[];
}

export interface StatusResponse {
  page_count: number;
  source_count: number;
  system_page_count: number;
}

export interface MirrorFrontmatter {
  page_id: string;
  slug: string;
  page_type: PluginPageType;
  revision_id: string;
  updated_at: number;
  mirror: true;
}

export interface CommitPageChange {
  change_type: "Update" | "Delete";
  page_id: string;
  base_revision_id: string;
  new_markdown: string | null;
}

export interface RejectedPageResult {
  page_id: string;
  reason: string;
  conflicting_section_paths: string[];
  local_changed_section_paths: string[];
  remote_changed_section_paths: string[];
  conflict_markdown: string | null;
}

export interface CommitWikiChangesResponse {
  committed_pages: Array<{
    page_id: string;
    revision_id: string;
    section_hashes: SectionHashEntry[];
  }>;
  rejected_pages: RejectedPageResult[];
  snapshot_revision: string;
  snapshot_was_stale: boolean;
  system_pages: SystemPageSnapshot[];
  manifest_delta: {
    upserted_pages: WikiSyncManifestEntry[];
    removed_page_ids: string[];
  };
}

const DEFAULTS: PluginSettings = {
  replicaHost: "",
  canisterId: "",
  mirrorRoot: "Wiki",
  autoPullOnStartup: true,
  openIndexAfterInitialSync: true,
  lastSnapshotRevision: "",
  lastSyncedAt: 0
};

export function defaultPluginSettings(): PluginSettings {
  return { ...DEFAULTS };
}

export function parsePluginSettings(input: unknown): PluginSettings {
  if (!isRecord(input)) {
    return defaultPluginSettings();
  }
  return {
    replicaHost: readString(input, "replicaHost", DEFAULTS.replicaHost),
    canisterId: readString(input, "canisterId", DEFAULTS.canisterId),
    mirrorRoot: readString(input, "mirrorRoot", DEFAULTS.mirrorRoot),
    autoPullOnStartup: readBoolean(input, "autoPullOnStartup", DEFAULTS.autoPullOnStartup),
    openIndexAfterInitialSync: readBoolean(
      input,
      "openIndexAfterInitialSync",
      DEFAULTS.openIndexAfterInitialSync
    ),
    lastSnapshotRevision: readString(
      input,
      "lastSnapshotRevision",
      DEFAULTS.lastSnapshotRevision
    ),
    lastSyncedAt: readNumber(input, "lastSyncedAt", DEFAULTS.lastSyncedAt)
  };
}

export function isExportSnapshotResponse(input: unknown): input is ExportWikiSnapshotResponse {
  return isRecord(input) && isString(input.snapshot_revision) && isPageArray(input.pages) && isSystemPageArray(input.system_pages);
}

export function isFetchWikiUpdatesResponse(input: unknown): input is FetchWikiUpdatesResponse {
  return isRecord(input)
    && isString(input.snapshot_revision)
    && isPageArray(input.changed_pages)
    && isStringArray(input.removed_page_ids)
    && isSystemPageArray(input.system_pages);
}

export function isStatusResponse(input: unknown): input is StatusResponse {
  return isRecord(input)
    && isNumberValue(input.page_count)
    && isNumberValue(input.source_count)
    && isNumberValue(input.system_page_count);
}

export function isCommitWikiChangesResponse(input: unknown): input is CommitWikiChangesResponse {
  return isRecord(input)
    && isCommittedArray(input.committed_pages)
    && isRejectedArray(input.rejected_pages)
    && isString(input.snapshot_revision)
    && isBooleanValue(input.snapshot_was_stale)
    && isSystemPageArray(input.system_pages)
    && isManifestDelta(input.manifest_delta);
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null;
}

function isString(input: unknown): input is string {
  return typeof input === "string";
}

function isBooleanValue(input: unknown): input is boolean {
  return typeof input === "boolean";
}

function isNumberValue(input: unknown): input is number {
  return typeof input === "number" && Number.isFinite(input);
}

function isStringArray(input: unknown): input is string[] {
  return Array.isArray(input) && input.every(isString);
}

function isPageType(input: unknown): input is PluginPageType {
  return isString(input)
    && ["entity", "concept", "overview", "comparison", "query_note", "source_summary"].includes(input);
}

function isSectionHashEntry(input: unknown): input is SectionHashEntry {
  return isRecord(input) && isString(input.section_path) && isString(input.content_hash);
}

function isPageSnapshot(input: unknown): input is WikiPageSnapshot {
  return isRecord(input)
    && isString(input.page_id)
    && isString(input.slug)
    && isString(input.title)
    && isPageType(input.page_type)
    && isString(input.revision_id)
    && isNumberValue(input.updated_at)
    && isString(input.markdown)
    && Array.isArray(input.section_hashes)
    && input.section_hashes.every(isSectionHashEntry);
}

function isSystemPage(input: unknown): input is SystemPageSnapshot {
  return isRecord(input)
    && isString(input.slug)
    && isString(input.markdown)
    && isNumberValue(input.updated_at)
    && isString(input.etag);
}

function isManifestEntry(input: unknown): input is WikiSyncManifestEntry {
  return isRecord(input)
    && isString(input.page_id)
    && isString(input.slug)
    && isString(input.revision_id)
    && isNumberValue(input.updated_at);
}

function isRejected(input: unknown): input is RejectedPageResult {
  return isRecord(input)
    && isString(input.page_id)
    && isString(input.reason)
    && isStringArray(input.conflicting_section_paths)
    && isStringArray(input.local_changed_section_paths)
    && isStringArray(input.remote_changed_section_paths)
    && (input.conflict_markdown === null || isString(input.conflict_markdown));
}

function isCommittedArray(input: unknown): input is CommitWikiChangesResponse["committed_pages"] {
  return Array.isArray(input) && input.every((entry) => {
    return isRecord(entry)
      && isString(entry.page_id)
      && isString(entry.revision_id)
      && Array.isArray(entry.section_hashes)
      && entry.section_hashes.every(isSectionHashEntry);
  });
}

function isRejectedArray(input: unknown): input is RejectedPageResult[] {
  return Array.isArray(input) && input.every(isRejected);
}

function isPageArray(input: unknown): input is WikiPageSnapshot[] {
  return Array.isArray(input) && input.every(isPageSnapshot);
}

function isSystemPageArray(input: unknown): input is SystemPageSnapshot[] {
  return Array.isArray(input) && input.every(isSystemPage);
}

function isManifestDelta(input: unknown): input is CommitWikiChangesResponse["manifest_delta"] {
  return isRecord(input)
    && Array.isArray(input.upserted_pages)
    && input.upserted_pages.every(isManifestEntry)
    && isStringArray(input.removed_page_ids);
}

function readString(source: Record<string, unknown>, key: string, fallback: string): string {
  return isString(source[key]) ? source[key] : fallback;
}

function readBoolean(source: Record<string, unknown>, key: string, fallback: boolean): boolean {
  return isBooleanValue(source[key]) ? source[key] : fallback;
}

function readNumber(source: Record<string, unknown>, key: string, fallback: number): number {
  return isNumberValue(source[key]) ? source[key] : fallback;
}
