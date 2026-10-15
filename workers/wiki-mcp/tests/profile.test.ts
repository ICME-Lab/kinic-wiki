import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AnonymousIdentity, type Identity } from "@icp-sdk/core/agent";
import { DelegationChain } from "@icp-sdk/core/identity";
import { generateIiKey, restoreKinicIdentity } from "@kinic/ii-server/internet-identity";
import { describe, expect, it, vi } from "vitest";
import { createServer } from "../src/index.js";
import type { RuntimeEnv } from "../src/vfs.js";
import { restoreReviewServiceIdentity } from "../src/auth/review-identity.js";
import { Principal } from "@icp-sdk/core/principal";

const targetOrigin = "https://6emaw-iyaaa-aaaay-aacka-cai.ic0.app";

async function withClient<T>(env: RuntimeEnv, run: (client: Client) => Promise<T>, privateMode = true, writesAvailable = true) {
  const server = createServer(env, { accessPolicy: privateMode ? "private_required" : "public", writesAvailable });
  const client = new Client({ name: "profile-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

function authorized(identity?: Identity, scopes = ["mcp:read"], identitySource: "internet_identity" | "review_service" = "internet_identity"): RuntimeEnv {
  return {
    KINIC_WIKI_IDENTITY: identity,
    KINIC_WIKI_AUTHORIZATION: { scopes, actionPermission: "queries", identitySource }
  };
}

describe("connection profile", () => {
  it.each([false, true])("registers an app-only authenticated profile with writes=%s", async writesAvailable => {
    await withClient({}, async client => {
      const { tools } = await client.listTools();
      const profile = tools.find(tool => tool.name === "get_profile")!;
      expect(tools).toHaveLength(writesAvailable ? 16 : 8);
      expect(tools.filter(tool => (tool._meta?.ui as { visibility: string[] } | undefined)?.visibility?.includes("model") ?? true)).toHaveLength(writesAvailable ? 15 : 7);
      expect(profile.inputSchema).toMatchObject({ type: "object", properties: {}, additionalProperties: false });
      expect(profile.outputSchema).toMatchObject({ type: "object", required: ["id"], additionalProperties: false });
      expect(Object.keys(profile.outputSchema!.properties!)).toEqual(["id", "nickname"]);
      expect(profile.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
      expect(profile._meta).toEqual({ securitySchemes: [{ type: "oauth2", scopes: ["mcp:read"] }], "openai/profile": true, ui: { visibility: ["app"] } });
    }, true, writesAvailable);
  });

  it("does not register the profile on the anonymous public server", async () => {
    await withClient({}, async client => {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(7);
      expect(tools.some(tool => tool.name === "get_profile")).toBe(false);
      await expect(client.callTool({ name: "get_profile", arguments: {} })).resolves.toMatchObject({ isError: true });
    }, false, false);
  });

  it("returns the same root PID after restoring signed delegations with different app keys and scopes", async () => {
    const root = generateIiKey();
    const foreign = generateIiKey();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("profile must not access the network"));
    const logSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const calls = [root, root, foreign].map(async (key, index) => {
        const appKey = generateIiKey();
        const expiresAt = Date.now() + 60_000;
        const chain = await DelegationChain.create(key, appKey.getPublicKey(), new Date(expiresAt));
        const identity = restoreKinicIdentity({ version: 1, targetOrigin, expiresAt, appKey: appKey.toJSON(), delegation: chain.toJSON() }, targetOrigin, Date.now());
        return withClient(authorized(identity, index === 1 ? ["mcp:read", "mcp:write"] : ["mcp:read"]), client => client.callTool({ name: "get_profile", arguments: {} }));
      });
      const results = await Promise.all(calls);
      for (const [index, result] of results.entries()) {
        const id = (index === 2 ? foreign : root).getPrincipal().toText();
        const profile = { id, nickname: `Kinic Wiki · ${id.slice(0, 10)}…${id.slice(-5)}` };
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toEqual(profile);
        expect(result.content).toEqual([{ type: "text", text: JSON.stringify(profile) }]);
      }
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(logSpy.mock.calls).toEqual(Array(3).fill([JSON.stringify({ event: "mcp_profile", outcome: "ok" })]));
    } finally { fetchSpy.mockRestore(); logSpy.mockRestore(); }
  });

  it("uses the validated review identity without inventing display metadata", async () => {
    const key = generateIiKey();
    const identity = restoreReviewServiceIdentity(JSON.stringify(key.toJSON()), key.getPrincipal().toText());
    const result = await withClient(authorized(identity, ["mcp:read"], "review_service"), client => client.callTool({ name: "get_profile", arguments: {} }));
    const id = key.getPrincipal().toText();
    expect(result.structuredContent).toEqual({ id, nickname: `Kinic Wiki · ${id.slice(0, 10)}…${id.slice(-5)}` });
    expect(result.structuredContent).not.toHaveProperty("name");
    expect(result.structuredContent).not.toHaveProperty("email");
  });

  it.each([
    ["rrkah-fqaaa-aaaaa-aaaaq-cai", "Kinic Wiki · rrkah-fqaa…q-cai"],
    ["aaaaa-aa", "Kinic Wiki · aaaaa-aa"]
  ])("labels PID %s without changing the full identity", async (id, nickname) => {
    const identity = { getPrincipal: () => Principal.fromText(id) } as unknown as Identity;
    const result = await withClient(authorized(identity), client => client.callTool({ name: "get_profile", arguments: {} }));
    expect(result.structuredContent).toEqual({ id, nickname });
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ id, nickname }) }]);
  });

  it.each([
    authorized(),
    authorized(new AnonymousIdentity()),
    authorized(generateIiKey(), []),
    { KINIC_WIKI_IDENTITY: generateIiKey() },
    authorized({ getPrincipal: () => { throw new Error("private identity detail"); } } as unknown as Identity)
  ])("fails closed when authenticated profile identity is unavailable", async runtimeEnv => {
    const result = await withClient(runtimeEnv, client => client.callTool({ name: "get_profile", arguments: {} }));
    expect(result.isError).toBe(true);
    expect(result.structuredContent ?? {}).not.toHaveProperty("id");
    expect(JSON.stringify(result)).not.toContain("private identity detail");
  });

  it("rejects caller-supplied identity selectors", async () => {
    await withClient(authorized(generateIiKey()), async client => {
      for (const args of [{ id: "other" }, { email: "other@example.test" }, { account: "other" }]) {
        expect(await client.callTool({ name: "get_profile", arguments: args })).toMatchObject({ isError: true });
      }
    });
  });
});
