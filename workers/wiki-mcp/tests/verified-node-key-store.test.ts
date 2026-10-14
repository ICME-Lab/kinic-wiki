import { afterEach, expect, it, vi } from "vitest";
import type { DerEncodedPublicKey } from "@icp-sdk/core/agent";
import { scopedVerifiedNodeKeys, VerifiedNodeKeyStore } from "@kinic/ii-server/verified-node-key-store";

afterEach(() => vi.useRealTimers());
const keys = () => new Map([["node", new Uint8Array([1, 2, 3]) as DerEncodedPublicKey]]);

it("isolates endpoints and trust roots, including a root fetched after construction", async () => {
  const store = new VerifiedNodeKeyStore();
  let root: Uint8Array | null = null;
  const first = scopedVerifiedNodeKeys("https://icp0.io", () => root, store);
  const same = scopedVerifiedNodeKeys("https://icp0.io/", () => new Uint8Array([1]), store);
  const otherHost = scopedVerifiedNodeKeys("http://localhost:8000", () => new Uint8Array([1]), store);
  const otherRoot = scopedVerifiedNodeKeys("https://icp0.io", () => new Uint8Array([2]), store);
  await first.set("canister", keys());
  expect(await first.get("canister")).toBeUndefined();
  root = new Uint8Array([1]);
  await first.set("canister", keys());
  expect(await same.get("canister")).toEqual(keys());
  expect(await otherHost.get("canister")).toBeUndefined();
  expect(await otherRoot.get("canister")).toBeUndefined();
  root = new Uint8Array([2]);
  expect(await first.get("canister")).toBeUndefined();
});

it("defensively copies keys, expires them and invalidates only the matching scope", async () => {
  vi.useFakeTimers();
  const store = new VerifiedNodeKeyStore();
  const first = scopedVerifiedNodeKeys("https://icp0.io", () => new Uint8Array([1]), store);
  const other = scopedVerifiedNodeKeys("https://icp0.io", () => new Uint8Array([2]), store);
  const input = keys();
  await first.set("canister", input);
  await other.set("canister", input);
  input.clear();
  (await first.get("canister"))!.get("node")![0] = 9;
  expect(await first.get("canister")).toEqual(keys());
  await first.delete("canister");
  expect(await first.get("canister")).toBeUndefined();
  expect(await other.get("canister")).toEqual(keys());
  vi.advanceTimersByTime(store.expirationTime);
  expect(await other.get("canister")).toBeUndefined();
});

it("bounds all endpoint/root partitions together", async () => {
  const store = new VerifiedNodeKeyStore();
  for (let i = 0; i < 17; i++) {
    await scopedVerifiedNodeKeys(`https://host${i}.example`, () => new Uint8Array([1]), store).set("canister", keys());
  }
  expect(await scopedVerifiedNodeKeys("https://host0.example", () => new Uint8Array([1]), store).get("canister")).toBeUndefined();
});
