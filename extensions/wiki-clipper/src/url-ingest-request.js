// Where: extensions/wiki-clipper/src/url-ingest-request.js
// What: Build URL ingest request VFS nodes and generator trigger payloads.
// Why: Toolbar clicks should queue the same request shape as Wiki Browser.

export const DEFAULT_CANISTER_ID = "xis3j-paaaa-aaaai-axumq-cai";
export const DEFAULT_IC_HOST = "https://icp0.io";
export const URL_INGEST_STATUS_KEY = "kinic-url-ingest-status-v1";

export function buildUrlIngestRequest({ url, requestedBy, now = new Date(), uuid = crypto.randomUUID() }) {
  const normalizedUrl = normalizedHttpUrl(url);
  const requestedAt = now.toISOString();
  const requestId = `${now.getTime()}-${uuid}`;
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
