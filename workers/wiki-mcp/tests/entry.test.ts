import { beforeEach, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../src/vfs.js";

const fallback = vi.hoisted(() => vi.fn());
vi.mock("../src/index.js", () => ({ default: { fetch: fallback } }));
import entry from "../src/entry.js";

beforeEach(() => { fallback.mockReset(); fallback.mockResolvedValue(new Response("fallback")); });

it("streams the original request to its session exactly once", async () => {
  const response = new Response("MCP response", { headers: { "content-type": "text/event-stream" } });
  const fetch = vi.fn().mockResolvedValue(response);
  const getByName = vi.fn().mockReturnValue({ fetch });
  const env = { MCP_ACCESS_POLICY: "private_required", MCP_AUTH_STATE: { getByName } } as unknown as RuntimeEnv;
  const request = new Request("https://wiki-private-mcp.kinic.xyz/mcp", {
    method: "POST", headers: { authorization: "Bearer mka1.session_A.secret" }, body: "untouched"
  });
  expect(await entry.fetch(request, env)).toBe(response);
  expect(getByName).toHaveBeenCalledWith("session:session_A");
  expect(fetch).toHaveBeenCalledExactlyOnceWith(request);
  expect(request.bodyUsed).toBe(false);
  expect(fallback).not.toHaveBeenCalled();
});

it.each([undefined, "Basic token", "Bearer bad", "Bearer mkr1.session.secret", "Bearer mka1.!.secret"])(
  "keeps malformed tokens on the existing HTTP boundary (%s)", async (authorization) => {
    const getByName = vi.fn();
    const env = { MCP_ACCESS_POLICY: "private_required", MCP_AUTH_STATE: { getByName } } as unknown as RuntimeEnv;
    const request = new Request("https://wiki-private-mcp.kinic.xyz/mcp", {
      method: "POST", headers: authorization ? { authorization } : {}, body: "{}"
    });
    await entry.fetch(request, env);
    expect(fallback).toHaveBeenCalledExactlyOnceWith(request, env);
    expect(getByName).not.toHaveBeenCalled();
  }
);

it("does not retry a failed session call that might have performed a write", async () => {
  const fetch = vi.fn().mockRejectedValue(new Error("disconnected"));
  const env = { MCP_ACCESS_POLICY: "private_required", MCP_AUTH_STATE: { getByName: () => ({ fetch }) } } as unknown as RuntimeEnv;
  const request = new Request("https://wiki-private-mcp.kinic.xyz/mcp", {
    method: "POST", headers: { authorization: "Bearer mka1.session.secret" }, body: "{}"
  });
  await expect(entry.fetch(request, env)).rejects.toThrow("disconnected");
  expect(fetch).toHaveBeenCalledOnce();
  expect(fallback).not.toHaveBeenCalled();
});

it.each([
  { policy: "public", method: "POST", path: "/mcp" },
  { policy: "private_required", method: "GET", path: "/mcp" },
  { policy: "private_required", method: "POST", path: "/oauth/token" },
  { policy: "invalid", method: "POST", path: "/mcp" }
])("preserves the existing $policy $method $path path", async ({ policy, method, path }) => {
  const getByName = vi.fn();
  const env = { MCP_ACCESS_POLICY: policy, MCP_AUTH_STATE: { getByName } } as unknown as RuntimeEnv;
  const request = new Request(`https://wiki-private-mcp.kinic.xyz${path}`, {
    method, headers: { authorization: "Bearer mka1.session.secret" }
  });
  await entry.fetch(request, env);
  expect(fallback).toHaveBeenCalledExactlyOnceWith(request, env);
  expect(getByName).not.toHaveBeenCalled();
});
