import type { Identity } from "@icp-sdk/core/agent";
import { authorizeSourceCaptureTriggerSession, mkdirNodeAuthenticated, writeNodeAuthenticated } from "@/lib/vfs-client";

export type CreatedSourceCaptureRequest = {
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

export async function createSourceCaptureRequest(canisterId: string, databaseId: string, identity: Identity, url: string): Promise<CreatedSourceCaptureRequest> {
  const normalizedUrl = normalizedHttpUrl(url);
  const session = await ensureSourceCaptureTriggerSession(canisterId, databaseId, identity);
  const requestId = safeSourceCaptureRequestId(Date.now(), crypto.randomUUID());
  const requestPath = `/Sources/source-capture-requests/${requestId}.md`;
  const requestedAt = new Date().toISOString();
  const requestedBy = identity.getPrincipal().toText();
  await ensureParentFolders(canisterId, databaseId, identity, requestPath);
  await writeNodeAuthenticated(canisterId, identity, {
    databaseId,
    path: requestPath,
    kind: "file",
    content: [
      "---",
      "kind: kinic.source_capture_request",
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
      "# Source Capture Request",
      ""
    ].join("\n"),
    metadataJson: JSON.stringify({ request_type: "source_capture", url: normalizedUrl }),
    expectedEtag: null
  });
  const trigger = await triggerWorker(canisterId, databaseId, requestPath, session);
  return { requestPath, triggered: trigger.ok, triggerError: trigger.error };
}

export function safeSourceCaptureRequestId(timeMs: number, uuid: string): string {
  const suffix = uuid.trim();
  if (!isSafeRequestSegment(suffix) || suffix.length > 96) {
    throw new Error("source capture request id is invalid.");
  }
  const requestId = `${timeMs}-${suffix}`;
  if (!isSafeRequestSegment(requestId) || requestId.length > 128) {
    throw new Error("source capture request id is invalid.");
  }
  return requestId;
}

function isSafeRequestSegment(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && value !== "." && value !== ".." && !value.includes("..");
}

async function ensureParentFolders(canisterId: string, databaseId: string, identity: Identity, path: string): Promise<void> {
  const segments = path.split("/").filter(Boolean);
  let current = "";
  for (const segment of segments.slice(0, -1)) {
    current = `${current}/${segment}`;
    await mkdirNodeAuthenticated(canisterId, identity, { databaseId, path: current });
  }
}

export async function ensureSourceCaptureTriggerSession(canisterId: string, databaseId: string, identity: Identity): Promise<string> {
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
  const promise = authorizeSourceCaptureTriggerSession(canisterId, identity, { databaseId, sessionNonce })
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
    const response = await fetch("/api/source-capture/trigger", {
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
