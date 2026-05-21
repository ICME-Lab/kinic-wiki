// Where: extensions/wiki-clipper/src/history-links.js
// What: Normalize user-supplied recent export limits.
// Why: Direct API export still needs bounded user input.
export const DEFAULT_EXPORT_LIMIT = 10;
export const MAX_EXPORT_LIMIT = 100;

export function normalizeExportLimit(value) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_EXPORT_LIMIT;
  }
  return Math.min(MAX_EXPORT_LIMIT, Math.max(1, parsed));
}
