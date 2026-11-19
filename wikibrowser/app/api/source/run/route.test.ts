import { afterEach, expect, test, vi } from "vitest";
import { POST, setSourceRunDepsForTest } from "./route";
afterEach(() => { vi.unstubAllGlobals(); setSourceRunDepsForTest(); });
const input = { canisterId: "aaaaa-aa", databaseId: "db_1", sourcePath: "/Sources/web/a.md", sourceEtag: "etag-1", sessionNonce: "session-1" };
const env = { KINIC_WIKI_CANISTER_ID: "aaaaa-aa", KINIC_WIKI_GENERATOR_URL: "https://generator.example", KINIC_WIKI_WORKER_TOKEN: "test-token" };
function request(body: unknown) { return new Request("https://wiki.kinic.xyz/api/source/run", { method: "POST", headers: { origin: "https://wiki.kinic.xyz", "content-type": "application/json" }, body: JSON.stringify(body) }); }
test("source run forwards a normalized generation destination after session authorization", async () => {
  setSourceRunDepsForTest({ checkSession: async () => {} });
  let body: Record<string, unknown> = {};
  vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => { body = JSON.parse(String(init.body)); return new Response("{}", {status: 202}); });
  expect((await POST(request({...input, targetRoot: "/Knowledge/articles/"}), env)).status).toBe(202);
  expect(body.targetRoot).toBe("/Knowledge/articles");
});
test("source run rejects invalid destinations before contacting generation service", async () => {
  setSourceRunDepsForTest({ checkSession: async () => {} });
  vi.stubGlobal("fetch", async () => new Response("{}", { status: 202 }));
  for (const targetRoot of ["", null, "/Sources/a", "/Knowledge/../a"]) {
    expect((await POST(request({...input, targetRoot}), env)).status).toBe(400);
  }
});

test("source run preserves destination conflict instead of reporting an etag mismatch", async () => {
  setSourceRunDepsForTest({ checkSession: async () => {} });
  vi.stubGlobal("fetch", async () => Response.json({ error: "source_target_conflict" }, { status: 409 }));
  const response = await POST(request({ ...input, targetRoot: "/Knowledge/other" }), env);
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "source_target_conflict" });
});
