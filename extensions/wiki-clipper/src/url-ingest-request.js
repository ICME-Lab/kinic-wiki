// Where: extensions/wiki-clipper/src/url-ingest-request.js
// What: Normalize extension input URLs, build URL ingest request nodes, and expose fixed runtime defaults.
// Why: Toolbar clicks still queue URL ingest requests while active-tab captures write evidence sources directly.

export const DEFAULT_CANISTER_ID = "xis3j-paaaa-aaaai-axumq-cai";
export const DEFAULT_IC_HOST = "https://icp0.io";
export const SOURCE_CAPTURE_STATUS_KEY = "kinic-source-capture-status-v1";
export const URL_INGEST_STATUS_KEY = SOURCE_CAPTURE_STATUS_KEY;

export function buildUrlIngestRequest({ url, requestedBy, now = new Date(), uuid = crypto.randomUUID() }) {
  const normalizedUrl = normalizedHttpUrl(url);
  const requestedAt = now.toISOString();
  const requestId = safeIngestRequestId(now.getTime(), uuid);
  const requestPath = `/Sources/ingest-requests/${requestId}.md`;
  return {
    requestPath,
    writeRequest: {
      path: requestPath,
      kind: { File: null },
      content: [
        "---",
        "kind: kinic.url_ingest_request",
        "schema_version: 1",
        "status: queued",
        `url: ${JSON.stringify(normalizedUrl)}`,
        `requested_by: ${JSON.stringify(requestedBy)}`,
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
      ].join("\n"),
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

export function safeIngestRequestId(timeMs, uuid) {
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
