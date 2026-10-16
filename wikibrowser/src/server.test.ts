import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), match: vi.fn(), put: vi.fn(), env: {} as Record<string, unknown> }));
vi.mock("@tanstack/react-start/server", () => ({ createStartHandler: () => mocks.fetch, defaultStreamHandler: {} }));
vi.mock("@tanstack/react-start/server-entry", () => ({ createServerEntry: (entry: unknown) => entry }));
vi.mock("cloudflare:workers", () => ({ env: mocks.env }));
import server from "./server";

beforeEach(() => {
  mocks.fetch.mockImplementation(async () => new Response("Article", { headers: { "Cache-Control": "public, max-age=86400", "Content-Type": "text/html" } }));
  mocks.match.mockResolvedValue(undefined);
  mocks.put.mockResolvedValue(undefined);
  vi.stubGlobal("caches", { default: { match: mocks.match, put: mocks.put } });
});
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); for (const key of Object.keys(mocks.env)) delete mocks.env[key]; });

describe("service discovery", () => {
  const ids = ["6emaw-iyaaa-aaaay-aacka-cai", "3ryrw-kyaaa-aaaaf-qgxpq-cai"];
  for (const id of ids) {
    it.each(["wiki.kinic.xyz", "kinic.xyz"])(`declares only ${id} at %s before redirects or HTML`, async (host) => {
      mocks.env.KINIC_WIKI_CANISTER_ID = id;
      const response = await server.fetch(new Request(`https://${host}/.well-known/ic-architecture`));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ version: "1.0.0", canisters: [{
        id, name: "wiki", role: "backend", description: "Kinic Wiki content API; call get_api_doc() first."
      }] });
      expect(mocks.fetch).not.toHaveBeenCalled();
      expect(mocks.match).not.toHaveBeenCalled();
      expect(mocks.put).not.toHaveBeenCalled();
    });

    it.each(["wiki.kinic.xyz", "kinic.xyz"])(`publishes the reachable browser II origin for ${id} at %s`, async (host) => {
      mocks.env.KINIC_WIKI_CANISTER_ID = id;
      const response = await server.fetch(new Request(`https://${host}/.well-known/ii-derivation-origin`));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/plain");
      expect(await response.text()).toBe(`https://${id}.icp0.io\n`);
      expect(mocks.fetch).not.toHaveBeenCalled();
    });
  }

  it.each([undefined, "", "not-a-principal", "aaaaa-aa", "2vxsx-fae", "6emaw-iyaaa-aaaay-aackb-cai", " 6emaw-iyaaa-aaaay-aacka-cai"])("fails closed for invalid canister configuration %s", async (id) => {
    mocks.env.KINIC_WIKI_CANISTER_ID = id;
    for (const path of ["ic-architecture", "ii-derivation-origin"]) {
      const response = await server.fetch(new Request(`https://wiki.kinic.xyz/.well-known/${path}`));
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ error: "discovery_not_configured" });
    }
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("serves HEAD, rejects writes, and retains staging robots headers", async () => {
    mocks.env.KINIC_WIKI_CANISTER_ID = ids[1];
    mocks.env.KINIC_DEPLOYMENT_ENV = "staging";
    for (const path of ["ic-architecture", "ii-derivation-origin"]) {
      const url = `https://kinic.xyz/.well-known/${path}`;
      const head = await server.fetch(new Request(url, { method: "HEAD" }));
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
      expect(head.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
      const post = await server.fetch(new Request(url, { method: "POST" }));
      expect(post.status).toBe(405);
      expect(post.headers.get("allow")).toBe("GET, HEAD");
    }
  });
});

describe("article response caching", () => {
  it.each(["/db/db_alpha/Knowledge", "/db/db_alpha/Knowledge/note.md?tab=explorer"])("never stores %s or reuses a previous HTML response", async (path) => {
    for (let i = 0; i < 2; i++) {
      const response = await server.fetch(new Request(`https://wiki.kinic.xyz${path}`));
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.text()).toBe("Article");
    }
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(mocks.match).not.toHaveBeenCalled();
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it("preserves staging robots headers and the response status", async () => {
    mocks.env.KINIC_DEPLOYMENT_ENV = "staging";
    mocks.fetch.mockResolvedValue(new Response("Missing", { status: 404 }));
    const response = await server.fetch(new Request("https://wiki.kinic.xyz/db/db_alpha/missing.md"));
    expect(response.status).toBe(404);
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.text()).toBe("Missing");
  });

  it("keeps the existing docs cache", async () => {
    await server.fetch(new Request("https://wiki.kinic.xyz/docs"));
    expect(mocks.match).toHaveBeenCalledTimes(1);
    expect(mocks.put).toHaveBeenCalledTimes(1);
  });
});
