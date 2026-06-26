// Where: extensions/wiki-clipper/src/url-ingest-request.js
// What: Normalize extension input URLs and expose fixed runtime defaults.
// Why: Browser snapshots should save source evidence directly under /Sources.

export const DEFAULT_CANISTER_ID = "xis3j-paaaa-aaaai-axumq-cai";
export const DEFAULT_IC_HOST = "https://icp0.io";
export const SOURCE_CAPTURE_STATUS_KEY = "kinic-source-capture-status-v1";

export function buildUrlIngestRequest({ url, requestedBy }) {
  const normalizedUrl = normalizedHttpUrl(url);
  const requestId = safeIngestRequestId(Date.now(), crypto.randomUUID());
  const requestPath = `/Sources/ingest-requests/${requestId}.md`;
  const requestedAt = new Date().toISOString();
  const requester = String(requestedBy || "");
  const content = [
    "---",
    "kind: kinic.url_ingest_request",
    "schema_version: 1",
    "status: queued",
    `url: ${JSON.stringify(normalizedUrl)}`,
    `requested_by: ${JSON.stringify(requester)}`,
    `requested_at: ${JSON.stringify(requestedAt)}`,
    "claimed_at: null",
    "source_path: null",
    "target_path: null",
    "finished_at: null",
    "error: null",
    "---",
    "",
    "# URL Ingest Request",
    ""
  ].join("\n");
  return {
    requestPath,
    writeRequest: {
      path: requestPath,
      kind: { File: null },
      content,
      metadataJson: JSON.stringify({ request_type: "url_ingest", url: normalizedUrl }),
      expectedEtag: []
    }
  };
}

export function normalizedHttpUrl(value) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    throw new Error("Enter a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("URL must use http or https.");
  }
  url.hash = "";
  return url.toString();
}

function safeIngestRequestId(timeMs, uuid) {
  const suffix = String(uuid || "").trim();
  if (!isSafeRequestSegment(suffix) || suffix.length > 96) {
    throw new Error("URL ingest request id is invalid.");
  }
  const requestId = `${timeMs}-${suffix}`;
  if (!isSafeRequestSegment(requestId) || requestId.length > 128) {
    throw new Error("URL ingest request id is invalid.");
  }
  return requestId;
}

function isSafeRequestSegment(value) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && value !== "." && value !== ".." && !value.includes("..");
}
