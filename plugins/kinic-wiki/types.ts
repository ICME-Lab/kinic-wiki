// Where: plugins/kinic-wiki/types.ts
// What: Runtime-safe DTOs for the FS-first plugin workflow.
// Why: The plugin mirrors node paths directly and persists tracked etags in settings.
import { normalizeStoredSnapshotRevision } from "./sync_logic";

export type NodeKind = "file" | "source";
export type NodeEntryKind = "directory" | NodeKind;
export type GlobNodeType = "file" | "directory" | "any";

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
  pendingConflictPaths: string[];
  trackedNodes: TrackedNodeState[];
}

export interface NodeSnapshot {
  path: string;
  kind: NodeKind;
  content: string;
  created_at: number;
  updated_at: number;
  etag: string;
  metadata_json: string;
}

export interface NodeEntry {
  path: string;
  kind: NodeEntryKind;
  updated_at: number;
  etag: string;
  has_children: boolean;
}

export interface SearchNodeHit {
  path: string;
  kind: NodeKind;
  snippet: string | null;
  score: number;
  match_reasons: string[];
}

export interface ExportSnapshotResponse {
  snapshot_revision: string;
  snapshot_session_id: string | null;
  nodes: NodeSnapshot[];
  next_cursor: string | null;
}

export interface FetchUpdatesResponse {
  snapshot_revision: string;
  changed_nodes: NodeSnapshot[];
  removed_paths: string[];
  next_cursor: string | null;
}

export interface NodeMutationAck {
  path: string;
  kind: NodeKind;
  updated_at: number;
  etag: string;
}

export interface WriteNodeResult {
  node: NodeMutationAck;
  created: boolean;
}

export interface EditNodeResult {
  node: NodeMutationAck;
  replacement_count: number;
}

export interface MkdirNodeResult {
  path: string;
  created: boolean;
}

export interface MoveNodeResult {
  node: NodeMutationAck;
  from_path: string;
  overwrote: boolean;
}

export interface GlobNodeHit {
  path: string;
  kind: NodeEntryKind;
  has_children: boolean;
}

export interface RecentNodeHit {
  path: string;
  kind: NodeKind;
  updated_at: number;
  etag: string;
}

export interface MultiEdit {
  old_text: string;
  new_text: string;
}

export interface MultiEditNodeResult {
  node: NodeMutationAck;
  replacement_count: number;
}

export interface DeleteNodeResult {
  path: string;
}

export interface StatusResponse {
  file_count: number;
  source_count: number;
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
  pendingConflictPaths: [],
  trackedNodes: []
};

export function defaultPluginSettings(): PluginSettings {
  return { ...DEFAULTS, pendingConflictPaths: [], trackedNodes: [] };
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
    lastSnapshotRevision: normalizeStoredSnapshotRevision(
      readString(input, "lastSnapshotRevision", DEFAULTS.lastSnapshotRevision)
    ),
    lastSyncedAt: readNumber(input, "lastSyncedAt", DEFAULTS.lastSyncedAt),
    pendingConflictPaths: readStringArray(input, "pendingConflictPaths"),
    trackedNodes: readTrackedNodes(input.trackedNodes)
  };
}

export function isStatusResponse(input: unknown): input is StatusResponse {
  return isRecord(input)
    && isNumberValue(input.file_count)
    && isNumberValue(input.source_count);
}

export function isNodeSnapshot(input: unknown): input is NodeSnapshot {
  return isRecord(input)
    && isString(input.path)
    && isNodeKind(input.kind)
    && isString(input.content)
    && isNumberValue(input.created_at)
    && isNumberValue(input.updated_at)
    && isString(input.etag)
    && isString(input.metadata_json);
}

export function isNodeEntry(input: unknown): input is NodeEntry {
  return isRecord(input)
    && isString(input.path)
    && isNodeEntryKind(input.kind)
    && isNumberValue(input.updated_at)
    && isString(input.etag)
    && isBooleanValue(input.has_children);
}

export function isSearchNodeHit(input: unknown): input is SearchNodeHit {
  return isRecord(input)
    && isString(input.path)
    && isNodeKind(input.kind)
    && isOptionalString(input.snippet)
    && isNumberValue(input.score)
    && isStringArray(input.match_reasons);
}

export function isExportSnapshotResponse(input: unknown): input is ExportSnapshotResponse {
  return isRecord(input)
    && isString(input.snapshot_revision)
    && isOptionalString(input.snapshot_session_id)
    && Array.isArray(input.nodes)
    && input.nodes.every(isNodeSnapshot)
    && isOptionalString(input.next_cursor);
}

export function isFetchUpdatesResponse(input: unknown): input is FetchUpdatesResponse {
  return isRecord(input)
    && isString(input.snapshot_revision)
    && Array.isArray(input.changed_nodes)
    && input.changed_nodes.every(isNodeSnapshot)
    && isStringArray(input.removed_paths)
    && isOptionalString(input.next_cursor);
}

export function isWriteNodeResult(input: unknown): input is WriteNodeResult {
  return isRecord(input)
    && isNodeMutationAck(input.node)
    && isBooleanValue(input.created);
}

export function isEditNodeResult(input: unknown): input is EditNodeResult {
  return isRecord(input)
    && isNodeMutationAck(input.node)
    && isNumberValue(input.replacement_count);
}

export function isMkdirNodeResult(input: unknown): input is MkdirNodeResult {
  return isRecord(input)
    && isString(input.path)
    && isBooleanValue(input.created);
}

export function isMoveNodeResult(input: unknown): input is MoveNodeResult {
  return isRecord(input)
    && isNodeMutationAck(input.node)
    && isString(input.from_path)
    && isBooleanValue(input.overwrote);
}

export function isGlobNodeHit(input: unknown): input is GlobNodeHit {
  return isRecord(input)
    && isString(input.path)
    && isNodeEntryKind(input.kind)
    && isBooleanValue(input.has_children);
}

export function isRecentNodeHit(input: unknown): input is RecentNodeHit {
  return isRecord(input)
    && isString(input.path)
    && isNodeKind(input.kind)
    && isNumberValue(input.updated_at)
    && isString(input.etag);
}

export function isMultiEdit(input: unknown): input is MultiEdit {
  return isRecord(input)
    && isString(input.old_text)
    && isString(input.new_text);
}

export function isMultiEditNodeResult(input: unknown): input is MultiEditNodeResult {
  return isRecord(input)
    && isNodeMutationAck(input.node)
    && isNumberValue(input.replacement_count);
}

export function isNodeMutationAck(input: unknown): input is NodeMutationAck {
  return isRecord(input)
    && isString(input.path)
    && isNodeKind(input.kind)
    && isNumberValue(input.updated_at)
    && isString(input.etag);
}

export function isDeleteNodeResult(input: unknown): input is DeleteNodeResult {
  return isRecord(input)
    && isString(input.path);
}

function readTrackedNodes(input: unknown): TrackedNodeState[] {
  return Array.isArray(input) ? input.filter(isTrackedNodeState) : [];
}

function readStringArray(input: Record<string, unknown>, key: string): string[] {
  return isStringArray(input[key]) ? input[key] : [];
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

function isOptionalString(input: unknown): input is string | null {
  return input === null || isString(input);
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
