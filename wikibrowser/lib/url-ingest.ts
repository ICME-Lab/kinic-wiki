import type { Identity } from "@icp-sdk/core/agent";
import { authorizeUrlIngestTriggerSession, mkdirNodeAuthenticated, writeNodeAuthenticated } from "@/lib/vfs-client";

export type CreatedUrlIngestRequest = {
  requestPath: string;
  triggered: boolean;
  triggerError: string | null;
};

const TRIGGER_SESSION_TTL_MS = 30 * 60 * 1000;
const TRIGGER_SESSION_REFRESH_MS = 2 * 60 * 1000;

type TriggerSessionCacheEntry = {
  sessionNonce: string;
  expiresAtMs: number;
  promise?: Promise<string>;
};

const triggerSessionCache = new Map<string, TriggerSessionCacheEntry>();

export async function createUrlIngestRequest(canisterId: string, databaseId: string, identity: Identity, url: string): Promise<CreatedUrlIngestRequest> {
  const normalizedUrl = normalizedHttpUrl(url);
  const session = await ensureUrlIngestTriggerSession(canisterId, databaseId, identity);
  const requestId = `${Date.now()}-${crypto.randomUUID()}`;
  const requestPath = `/Sources/ingest-requests/${requestId}.md`;
  const requestedAt = new Date().toISOString();
  const requestedBy = identity.getPrincipal().toText();
  await ensureParentFolders(canisterId, databaseId, identity, requestPath);
  await writeNodeAuthenticated(canisterId, identity, {
    databaseId,
    path: requestPath,
    kind: "file",
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
    expectedEtag: null
  });
  const trigger = await triggerWorker(canisterId, databaseId, requestPath, session);
  return { requestPath, triggered: trigger.ok, triggerError: trigger.error };
}

async function ensureParentFolders(canisterId: string, databaseId: string, identity: Identity, path: string): Promise<void> {
  const segments = path.split("/").filter(Boolean);
  let current = "";
  for (const segment of segments.slice(0, -1)) {
    current = `${current}/${segment}`;
    await mkdirNodeAuthenticated(canisterId, identity, { databaseId, path: current });
  }
}

export async function ensureUrlIngestTriggerSession(canisterId: string, databaseId: string, identity: Identity): Promise<string> {
  const principal = identity.getPrincipal().toText();
  const key = `${canisterId}\n${databaseId}\n${principal}`;
  const now = Date.now();
  const cached = triggerSessionCache.get(key);
  if (cached && cached.expiresAtMs - now > TRIGGER_SESSION_REFRESH_MS) {
    return cached.sessionNonce;
  }
  if (cached?.promise) {
    return cached.promise;
  }
  const sessionNonce = crypto.randomUUID();
  const promise = authorizeUrlIngestTriggerSession(canisterId, identity, { databaseId, sessionNonce })
    .then(() => {
      triggerSessionCache.set(key, {
        sessionNonce,
        expiresAtMs: now + TRIGGER_SESSION_TTL_MS
      });
      return sessionNonce;
    })
    .catch((cause) => {
      triggerSessionCache.delete(key);
      throw cause;
    });
  triggerSessionCache.set(key, {
    sessionNonce,
    expiresAtMs: now,
    promise
  });
  return promise;
}

function normalizedHttpUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Enter a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("URL must use http or https.");
  }
  url.hash = "";
  return url.toString();
}

async function triggerWorker(canisterId: string, databaseId: string, requestPath: string, sessionNonce: string): Promise<{ ok: boolean; error: string | null }> {
  try {
    const response = await fetch("/api/url-ingest/trigger", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ canisterId, databaseId, requestPath, sessionNonce })
    });
    if (!response.ok) {
      return { ok: false, error: `worker trigger failed: HTTP ${response.status}` };
    }
    return { ok: true, error: null };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : "worker trigger failed" };
  }
}
