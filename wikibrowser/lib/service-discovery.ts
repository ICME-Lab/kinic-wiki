import { Principal } from "@icp-sdk/core/principal";

const ARCHITECTURE_PATH = "/.well-known/ic-architecture";
const DERIVATION_ORIGIN_PATH = "/.well-known/ii-derivation-origin";

/**
 * Serve discovery before redirects, HTML and page caching. Deploy the canister's
 * get_api_doc query before publishing this manifest. Publishing opts the app into
 * ICP MCP and its operator terms; removing the manifest stops new calls once observed.
 */
export function serviceDiscoveryResponse(request: Request, canisterId: unknown): Response | null {
  const path = new URL(request.url).pathname;
  if (path !== ARCHITECTURE_PATH && path !== DERIVATION_ORIGIN_PATH) return null;
  const headers = { "cache-control": "no-store" };
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405, headers: { ...headers, allow: "GET, HEAD" } });
  }

  if (!isCanisterId(canisterId)) {
    return new Response(request.method === "HEAD" ? null : JSON.stringify({ error: "discovery_not_configured" }), {
      status: 503, headers: { ...headers, "content-type": "application/json" }
    });
  }

  const architecture = path === ARCHITECTURE_PATH;
  const body = architecture
    ? JSON.stringify({ version: "1.0.0", canisters: [{
      id: canisterId, name: "wiki", role: "backend", description: "Kinic Wiki content API; call get_api_doc() first."
    }] })
    // Browser II normalizes icp0.io to this seed origin; direct II callers do not.
    // Before release, verify the same II identity/account has the same principal through
    // the browser, Private MCP and ICP MCP. Do not change ACLs to mask a mismatch.
    : `https://${canisterId}.ic0.app\n`;
  return new Response(request.method === "HEAD" ? null : body, {
    headers: { ...headers, "content-type": architecture ? "application/json" : "text/plain; charset=utf-8" }
  });
}

function isCanisterId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const principal = Principal.fromText(value);
    const bytes = principal.toUint8Array();
    // Canister IDs are nonempty opaque principals; reject identities and management.
    return principal.toText() === value && bytes.length > 0 && bytes[bytes.length - 1] === 1;
  } catch {
    return false;
  }
}
