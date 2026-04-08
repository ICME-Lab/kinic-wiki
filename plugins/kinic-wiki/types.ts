// Where: plugins/kinic-wiki/types.ts
// What: Runtime-safe DTOs for the FS-first plugin workflow.
// Why: The plugin mirrors node paths directly and persists tracked etags in settings.
export type NodeKind = "file" | "source";
export type NodeEntryKind = "directory" | NodeKind;

export interface TrackedNodeState {
  path: string;
  kind: NodeKind;
  etag: string;
}

export interface PluginSettings {
  replicaHost: string;
  canisterId: string;
  mirrorRoot: string;
  autoPullOnStartup: boolean;
  lastSnapshotRevision: string;
  lastSyncedAt: number;
  trackedNodes: TrackedNodeState[];
}

export interface NodeSnapshot {
  path: string;
  kind: NodeKind;
  content: string;
  created_at: number;
  updated_at: number;
  etag: string;
  deleted_at: number | null;
  metadata_json: string;
}

export interface NodeEntry {
  path: string;
  kind: NodeEntryKind;
  updated_at: number;
  etag: string;
  deleted_at: number | null;
  has_children: boolean;
}

export interface SearchNodeHit {
  path: string;
  kind: NodeKind;
  snippet: string;
  score: number;
  match_reasons: string[];
}

export interface ExportSnapshotResponse {
  snapshot_revision: string;
  nodes: NodeSnapshot[];
}

export interface FetchUpdatesResponse {
  snapshot_revision: string;
  changed_nodes: NodeSnapshot[];
  removed_paths: string[];
}

export interface WriteNodeResult {
  node: NodeSnapshot;
  created: boolean;
}

export interface DeleteNodeResult {
  path: string;
  etag: string;
  deleted_at: number;
}

export interface StatusResponse {
  file_count: number;
  source_count: number;
  deleted_count: number;
}

export interface MirrorFrontmatter {
  path: string;
  kind: NodeKind;
  etag: string;
  updated_at: number;
  mirror: true;
}

const DEFAULTS: PluginSettings = {
  replicaHost: "",
  canisterId: "",
  mirrorRoot: "Wiki",
  autoPullOnStartup: true,
  lastSnapshotRevision: "",
  lastSyncedAt: 0,
  trackedNodes: []
};

export function defaultPluginSettings(): PluginSettings {
  return { ...DEFAULTS, trackedNodes: [] };
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
    lastSnapshotRevision: readString(input, "lastSnapshotRevision", DEFAULTS.lastSnapshotRevision),
    lastSyncedAt: readNumber(input, "lastSyncedAt", DEFAULTS.lastSyncedAt),
    trackedNodes: readTrackedNodes(input.trackedNodes)
  };
}

export function isStatusResponse(input: unknown): input is StatusResponse {
  return isRecord(input)
    && isNumberValue(input.file_count)
    && isNumberValue(input.source_count)
    && isNumberValue(input.deleted_count);
}

export function isNodeSnapshot(input: unknown): input is NodeSnapshot {
  return isRecord(input)
    && isString(input.path)
    && isNodeKind(input.kind)
    && isString(input.content)
    && isNumberValue(input.created_at)
    && isNumberValue(input.updated_at)
    && isString(input.etag)
    && (input.deleted_at === null || isNumberValue(input.deleted_at))
    && isString(input.metadata_json);
}

export function isNodeEntry(input: unknown): input is NodeEntry {
  return isRecord(input)
    && isString(input.path)
    && isNodeEntryKind(input.kind)
    && isNumberValue(input.updated_at)
    && isString(input.etag)
    && (input.deleted_at === null || isNumberValue(input.deleted_at))
    && isBooleanValue(input.has_children);
}

export function isSearchNodeHit(input: unknown): input is SearchNodeHit {
  return isRecord(input)
    && isString(input.path)
    && isNodeKind(input.kind)
    && isString(input.snippet)
    && isNumberValue(input.score)
    && isStringArray(input.match_reasons);
}

export function isExportSnapshotResponse(input: unknown): input is ExportSnapshotResponse {
  return isRecord(input)
    && isString(input.snapshot_revision)
    && Array.isArray(input.nodes)
    && input.nodes.every(isNodeSnapshot);
}

export function isFetchUpdatesResponse(input: unknown): input is FetchUpdatesResponse {
  return isRecord(input)
    && isString(input.snapshot_revision)
    && Array.isArray(input.changed_nodes)
    && input.changed_nodes.every(isNodeSnapshot)
    && isStringArray(input.removed_paths);
}

export function isWriteNodeResult(input: unknown): input is WriteNodeResult {
  return isRecord(input)
    && isNodeSnapshot(input.node)
    && isBooleanValue(input.created);
}

export function isDeleteNodeResult(input: unknown): input is DeleteNodeResult {
  return isRecord(input)
    && isString(input.path)
    && isString(input.etag)
    && isNumberValue(input.deleted_at);
}

function readTrackedNodes(input: unknown): TrackedNodeState[] {
  return Array.isArray(input) ? input.filter(isTrackedNodeState) : [];
}

function isTrackedNodeState(input: unknown): input is TrackedNodeState {
  return isRecord(input)
    && isString(input.path)
    && isNodeKind(input.kind)
    && isString(input.etag);
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

function isNodeKind(input: unknown): input is NodeKind {
  return input === "file" || input === "source";
}

function isNodeEntryKind(input: unknown): input is NodeEntryKind {
  return input === "directory" || isNodeKind(input);
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
