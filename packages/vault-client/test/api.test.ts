import { expect, it, vi } from "vitest";
import type { Header, _SERVICE } from "../src/contracts";
import { VaultClient } from "../src/api.ts";

const header = (n: number): Header => ({
  published_slot: [],
  generation: [],
  recovery_verifier: [],
  id: new Uint8Array(16).fill(n),
  epoch: 0n,
  sequence: 1n,
  state: { Active: null },
  normal: [],
  recovery: [],
  backup_at: [],
  backup_sequence: [],
  key_name: "test_key_1",
});
function actor(client: VaultClient, value: Record<string, unknown>) {
  Object.assign(client, { actorValue: value });
}
it("discards a late backup confirmation without replacing the next vault header", async () => {
  const client = new VaultClient();
  let resolve!: (value: { Ok: Header }) => void;
  actor(client, {
    finish_export: vi.fn(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    ),
  });
  client.header = header(1);
  const pending = client.confirmBackup(new Uint8Array(16), true);
  client.session.lock();
  const next = header(2);
  client.header = next;
  resolve({ Ok: header(1) });
  await expect(pending).rejects.toThrow("Locked");
  expect(client.header).toBe(next);
});
it("clears transport keys when bootstrap fails", async () => {
  const client = new VaultClient();
  actor(client, { list_credentials: async () => ({ Ok: [] }) });
  await expect(client.createKit()).rejects.toThrow();
  expect(client.session.transport).toBeUndefined();
  expect(client.session.raw).toBeUndefined();
});
