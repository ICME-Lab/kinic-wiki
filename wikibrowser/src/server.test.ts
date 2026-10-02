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
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); delete mocks.env.KINIC_DEPLOYMENT_ENV; });

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
