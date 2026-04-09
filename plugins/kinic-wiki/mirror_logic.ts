// Where: plugins/kinic-wiki/mirror_logic.ts
// What: Pure helpers for mirror deletion detection and conflict file naming.
// Why: These helpers should stay testable without the Obsidian runtime module.
import { TrackedNodeState } from "./types";

const utf8Encoder = new TextEncoder();
const CONFLICT_FILE_SUFFIX = ".conflict.md";
const CONFLICT_HASH_SEPARATOR = "--";
const CONFLICT_HASH_HEX_LENGTH = 16;
const CONFLICT_MAX_COMPONENT_BYTES = 255;
const CONFLICT_STEM_SEGMENTS = 2;
const CONFLICT_FALLBACK_STEM = "conflict";

export function findDeletedTrackedNodes(
  trackedNodes: TrackedNodeState[],
  toLocalPath: (remotePath: string) => string,
  localFileExists: (localPath: string) => boolean
): TrackedNodeState[] {
  return trackedNodes.filter((tracked) => !localFileExists(toLocalPath(tracked.path)));
}

export function conflictFilePath(mirrorRoot: string, remotePath: string): string {
  const normalized = normalizeRemotePath(remotePath);
  if (!normalized.startsWith("/Wiki")) {
    throw new Error(`unsupported remote path outside /Wiki: ${remotePath}`);
  }
  const relative = normalized.replace(/^\/Wiki\/?/, "");
  const stem = shortConflictStem(relative);
  const hash = shortConflictHash(normalized);
  return `${mirrorRoot.replace(/\/+/g, "/").replace(/\/$/, "")}/conflicts/${stem}${CONFLICT_HASH_SEPARATOR}${hash}${CONFLICT_FILE_SUFFIX}`;
}

function normalizeRemotePath(remotePath: string): string {
  const segments = remotePath.split("/").filter((segment) => segment.length > 0);
  return `/${segments.join("/")}`;
}

function shortConflictStem(relativePath: string): string {
  const segments = relativePath.split("/").filter((segment) => segment.length > 0);
  if (segments.length > 0) {
    segments[segments.length - 1] = segments[segments.length - 1].replace(/\.[^.]+$/, "");
  }
  const stem = segments
    .slice(Math.max(segments.length - CONFLICT_STEM_SEGMENTS, 0))
    .map(sanitizeConflictSegment)
    .filter((segment) => segment.length > 0)
    .join("__");
  return truncateConflictStem(stem.length > 0 ? stem : CONFLICT_FALLBACK_STEM);
}

function sanitizeConflictSegment(segment: string): string {
  return segment
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function truncateConflictStem(stem: string): string {
  const maxStemLength =
    CONFLICT_MAX_COMPONENT_BYTES
    - CONFLICT_HASH_SEPARATOR.length
    - CONFLICT_HASH_HEX_LENGTH
    - CONFLICT_FILE_SUFFIX.length;
  return stem.slice(0, maxStemLength);
}

function shortConflictHash(normalizedRemotePath: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of utf8Encoder.encode(normalizedRemotePath)) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(CONFLICT_HASH_HEX_LENGTH, "0");
}
