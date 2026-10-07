import { afterEach, expect, it, vi } from "vitest";
import { Actor, HttpAgent, type DerEncodedPublicKey } from "@icp-sdk/core/agent";
import { Ed25519KeyIdentity } from "@icp-sdk/core/identity";
import { VerifiedNodeKeyStore } from "../../../packages/ii-server/verified-node-key-store";
import { createReadActor } from "@kinic/ii-server/read";

afterEach(() => vi.useRealTimers());
const keys = () => new Map([["node", new Uint8Array([1, 2, 3]) as DerEncodedPublicKey]]);

it("shares only public verification keys while keeping actors and identities separate", () => {
  const a = Ed25519KeyIdentity.generate(new Uint8Array(32).fill(1));
  const b = Ed25519KeyIdentity.generate(new Uint8Array(32).fill(2));
  const first = Actor.agentOf(createReadActor("aaaaa-aa", a) as unknown as Actor) as HttpAgent;
  const second = Actor.agentOf(createReadActor("aaaaa-aa", b) as unknown as Actor) as HttpAgent;
  expect(first).not.toBe(second);
  expect(first.config.identity).toBe(a);
  expect(second.config.identity).toBe(b);
  expect(first.config.verifyQuerySignatures).toBe(true);
  expect(second.config.subnetNodeKeyExpirableStore).toBe(first.config.subnetNodeKeyExpirableStore);
});

it("expires, invalidates and isolates mutable copies of verified keys", async () => {
  vi.useFakeTimers();
  const store = new VerifiedNodeKeyStore();
  const original = keys();
  await store.set("canister", original);
  original.clear();
  const cached = (await store.get("canister"))!;
  cached.get("node")![0] = 9;
  cached.clear();
  expect((await store.get("canister"))!.get("node")![0]).toBe(1);
  await store.delete("canister");
  expect(await store.get("canister")).toBeUndefined();
  await store.set("canister", keys());
  vi.advanceTimersByTime(store.expirationTime);
  expect(await store.get("canister")).toBeUndefined();
});

it("bounds memory even when many canisters are queried", async () => {
  const store = new VerifiedNodeKeyStore();
  for (let i = 0; i < 17; i++) await store.set(String(i), keys());
  expect(await store.get("0")).toBeUndefined();
  expect(await store.get("16")).toBeDefined();
});

it("allows an explicit HTTPS response policy without changing the signing identity or default", () => {
  const identity = Ed25519KeyIdentity.generate(new Uint8Array(32).fill(3));
  const actor = createReadActor("aaaaa-aa", identity, { verifyQuerySignatures: false });
  const agent = Actor.agentOf(actor as unknown as Actor) as HttpAgent;
  expect(agent.config.identity).toBe(identity);
  expect(agent.config.verifyQuerySignatures).toBe(false);
  expect(agent.host.protocol).toBe("https:");
  const normal = Actor.agentOf(createReadActor("aaaaa-aa", identity) as unknown as Actor) as HttpAgent;
  expect(normal.config.verifyQuerySignatures).toBe(true);
});
