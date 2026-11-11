import { expect, it, vi } from "vitest";
import { VaultClient } from "../src/api";
import { Ed25519KeyIdentity } from "@icp-sdk/core/identity";
it("uses an injected Wiki identity and destroys its private session immediately", () => {
  const identity = Ed25519KeyIdentity.generate();
  const actor = {} as never;
  const client = new VaultClient({
    actor,
    identity,
    canister: "aaaaa-aa",
    local: true,
  });
  expect(client.identity).toBe(identity);
  expect(client.actor).toBe(actor);
  const raw = new Uint8Array(32).fill(9);
  client.session.raw = raw;
  const generation = client.session.capture();
  client.destroy();
  expect(raw.every((x) => x === 0)).toBe(true);
  expect(() => client.session.check(generation)).toThrow("Locked");
  expect(() => client.actor).toThrow("NotSignedIn");
});
it("fences a read that resolves after the owning session is destroyed", async () => {
  let resolve!: (value: { Ok: Uint8Array }) => void;
  const get_chunk = vi.fn(
    () =>
      new Promise<{ Ok: Uint8Array }>((r) => {
        resolve = r;
      }),
  );
  const client = new VaultClient({
    actor: { get_chunk } as never,
    identity: Ed25519KeyIdentity.generate(),
    canister: "aaaaa-aa",
    local: true,
  });
  client.session.root = {} as CryptoKey;
  const pending = client.read({
    vault: new Uint8Array(16),
    object: new Uint8Array(16),
    revision: 1n,
    sequence: 1n,
    manifest: new Uint8Array(),
    plain_size: 1n,
    chunk_hashes: [new Uint8Array(32)],
    deleted: false,
  });
  client.destroy();
  resolve({ Ok: new Uint8Array(16) });
  await expect(pending).rejects.toThrow("Locked");
});
