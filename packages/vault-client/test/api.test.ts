import { expect, it, vi } from "vitest";
import type { Header, _SERVICE } from "../src/contracts";
import { VaultClient } from "../src/api.ts";
import { openArchive } from "../../vault-backup/src/index.ts";
vi.mock("../../vault-backup/src/index.ts", async (original) => ({
  ...(await original<typeof import("../../vault-backup/src/index.ts")>()),
  openArchive: vi.fn(),
}));
const header = (n: number): Header => ({
  generation: [], recovery_verifier: [],
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
it("drops recovered key references and wipes bytes when import fails", async () => {
  const client = new VaultClient();
  const raw = new Uint8Array(32).fill(7);
  const root = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
  vi.mocked(openArchive).mockResolvedValueOnce({
    rootRaw: raw,
    root,
    header: {
      vault: "AQEBAQEBAQEBAQEBAQEBAQ",
      epoch: "0",
      sequence: "1",
      normal: { version: 1, nonce: "", ciphertext: "" },
      recovery: { version: 1, nonce: "", ciphertext: "" },
      key_name: "test_key_1",
    },
    records: [],
  } as unknown as Awaited<ReturnType<typeof openArchive>>);
  actor(client, {
    begin_restore: vi.fn(async () => ({ Err: { Conflict: null } })),
  });
  await expect(client.restore(new Uint8Array(), "AA")).rejects.toThrow(
    "Conflict",
  );
  expect(client.session.root).toBeUndefined();
  expect(client.session.raw).toBeUndefined();
  expect(client.session.transport).toBeUndefined();
  expect(raw.every((x) => x === 0)).toBe(true);
});
it("does not clear a newer session when a stale restore fails", async () => {
  const client = new VaultClient();
  let reject!: (error: Error) => void;
  vi.mocked(openArchive).mockImplementationOnce(
    () =>
      new Promise((_, r) => {
        reject = r;
      }),
  );
  const pending = client.restore(new Uint8Array(), "AA");
  client.session.lock();
  const next = new Uint8Array(32).fill(9);
  client.session.raw = next;
  reject(Error("Interrupted"));
  await expect(pending).rejects.toThrow("Interrupted");
  expect(client.session.raw).toBe(next);
  expect(next[0]).toBe(9);
});

it("clears transport keys when creating a vault fails during derive", async () => {
  const client = new VaultClient();
  actor(client, {
    reserve_vault: vi.fn(async () => ({ Ok: header(1) })),
    derive_vault_key: vi.fn(async () => {
      throw Error("Interrupted");
    }),
  });
  await expect(client.createKit()).rejects.toThrow("Interrupted");
  expect(client.session.transport).toBeUndefined();
});
