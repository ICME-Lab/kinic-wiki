import http from "node:http";
import { fileURLToPath } from "node:url";

const SOURCE_CAPTURE_PREFIX = "/Sources/source-capture-requests/";

export async function handleMockSourceCaptureRequest(request, env = process.env) {
  const url = new URL(request.url);
  if (request.method !== "POST" || url.pathname !== "/source-capture") {
    return jsonResponse({ error: "not found" }, 404);
  }

  const token = env.KINIC_WIKI_WORKER_TOKEN?.trim();
  if (!token) {
    return jsonResponse({ error: "KINIC_WIKI_WORKER_TOKEN is required" }, 503);
  }
  if (request.headers.get("authorization") !== `Bearer ${token}`) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }
  const parsed = parseSourceCaptureBody(body, env);
  if (typeof parsed === "string") {
    return jsonResponse({ error: parsed }, 400);
  }

  return jsonResponse(
    {
      accepted: true,
      canisterId: parsed.canisterId,
      databaseId: parsed.databaseId,
      requestPath: parsed.requestPath
    },
    202
  );
}

export function createMockSourceCaptureServer(env = process.env) {
  return http.createServer(async (incoming, outgoing) => {
    const chunks = [];
    incoming.on("data", (chunk) => chunks.push(chunk));
    incoming.on("end", async () => {
      try {
        const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
        const requestInit = {
          method: incoming.method,
          headers: incoming.headers
        };
        if (body) {
          requestInit.body = body;
          requestInit.duplex = "half";
        }
        const request = new Request(`http://127.0.0.1${incoming.url ?? "/"}`, requestInit);
        const response = await handleMockSourceCaptureRequest(request, env);
        outgoing.writeHead(response.status, Object.fromEntries(response.headers));
        outgoing.end(Buffer.from(await response.arrayBuffer()));
      } catch (error) {
        outgoing.writeHead(500, { "content-type": "application/json" });
        outgoing.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
    });
  });
}

function parseSourceCaptureBody(value, env) {
  if (!isRecord(value)) return "body must include canisterId, databaseId, requestPath, and sessionNonce";
  const canisterId = value.canisterId;
  const databaseId = value.databaseId;
  const requestPath = value.requestPath;
  const sessionNonce = value.sessionNonce;
  if (typeof canisterId !== "string" || canisterId.length === 0) return "canisterId is required";
  if (typeof databaseId !== "string" || databaseId.length === 0) return "databaseId is required";
  if (typeof requestPath !== "string" || requestPath.length === 0) return "requestPath is required";
  if (typeof sessionNonce !== "string" || sessionNonce.length === 0) return "sessionNonce is required";
  if (sessionNonce.length > 128) return "sessionNonce is too long";
  if (!isSourceCaptureRequestPath(requestPath)) return `invalid source capture request path: ${requestPath}`;
  const configuredCanisterId = env.KINIC_WIKI_CANISTER_ID?.trim();
  if (configuredCanisterId && canisterId !== configuredCanisterId) {
    return "canisterId does not match worker canister config";
  }
  return { canisterId, databaseId, requestPath, sessionNonce };
}

function isSourceCaptureRequestPath(path) {
  if (!path.startsWith(SOURCE_CAPTURE_PREFIX)) return false;
  const name = path.slice(SOURCE_CAPTURE_PREFIX.length);
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.md$/.test(name) && !name.includes("..");
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function isRecord(value) {
  return typeof value === "object" && value !== null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number.parseInt(process.env.KINIC_MOCK_SOURCE_CAPTURE_PORT ?? "8787", 10);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("KINIC_MOCK_SOURCE_CAPTURE_PORT must be a valid TCP port.");
  }
  const server = createMockSourceCaptureServer();
  server.listen(port, "127.0.0.1", () => {
    console.log(`mock source-capture worker listening on http://127.0.0.1:${port}`);
  });
}
