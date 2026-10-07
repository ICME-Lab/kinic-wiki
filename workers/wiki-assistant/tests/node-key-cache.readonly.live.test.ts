import { Principal } from "@icp-sdk/core/principal";
import { HttpAgent } from "@icp-sdk/core/agent";
import { VerifiedNodeKeyStore } from "../../../packages/ii-server/verified-node-key-store";
import { expect, it, vi } from "vitest";

// Only public mainnet subnet certificates are read; no private Wiki or provider
// credentials are used. Each request gets its own agent and signed-query checks.
it("reuses certificate-verified public keys across independent mainnet agents", async () => {
  const store = new VerifiedNodeKeyStore();
  const set = vi.spyOn(store, "set");
  let requests = 0;
  const fetchPublic: typeof fetch = (...args) => { requests++; return fetch(...args); };
  const agent = () => HttpAgent.createSync({
    host: "https://icp-api.io", verifyQuerySignatures: true,
    subnetNodeKeyExpirableStore: store, fetch: fetchPublic,
  });
  const canister = { canisterId: Principal.fromText("6emaw-iyaaa-aaaay-aacka-cai") };
  const firstAgent = agent();
  const start = process.cpuUsage();
  const first = await firstAgent.fetchSubnetKeys(canister);
  const cold = process.cpuUsage(start);
  const firstRequests = requests;
  const secondAgent = agent();
  const warmStart = process.cpuUsage();
  const second = await secondAgent.fetchSubnetKeys(canister);
  const warm = process.cpuUsage(warmStart);
  expect(secondAgent).not.toBe(firstAgent);
  expect(firstRequests).toBeGreaterThan(0);
  expect(requests).toBe(firstRequests);
  expect(second).toEqual(first);
  // SDK invalidation must force a freshly verified certificate, too.
  expect(set).toHaveBeenCalledTimes(1);
  await store.delete(set.mock.calls[0][0]);
  await agent().fetchSubnetKeys(canister);
  expect(requests).toBeGreaterThan(firstRequests);
  console.info(JSON.stringify({ event: "public_node_key_cache_validation", coldCpuMs: (cold.user + cold.system) / 1000, warmCpuMs: (warm.user + warm.system) / 1000, firstRequests }));
}, 60_000);

it("uses the native HTTPS policy for signed mainnet reads without certificate fetches", async () => {
  const { createReadActor } = await import("@kinic/ii-server/read");
  const { Ed25519KeyIdentity } = await import("@icp-sdk/core/identity");
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  vi.stubGlobal("fetch", ((...args: Parameters<typeof fetch>) => {
    requests.push(String(args[0]));
    return originalFetch(...args);
  }) as typeof fetch);
  try {
    const start = process.cpuUsage();
    const actor = createReadActor("6emaw-iyaaa-aaaay-aacka-cai", Ed25519KeyIdentity.generate(), { verifyQuerySignatures: false });
    // Never address a real private DB or output its contents.
    const result = await actor.memory_manifest({ database_id: "askai-read-policy-probe-" + crypto.randomUUID() });
    const cpu = process.cpuUsage(start);
    expect("Err" in result).toBe(true);
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0]).origin).toBe("https://icp0.io");
    expect(requests[0]).toMatch(/\/query$/u);
    console.info(JSON.stringify({ event: "native_https_read_policy_validation", cpuMs: (cpu.user + cpu.system) / 1000, queryRequests: requests.length, certificateRequests: 0, denied: true }));
  } finally { vi.unstubAllGlobals(); }
}, 60_000);
