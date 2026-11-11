import { expect, it, vi } from "vitest";
import { Ed25519KeyIdentity } from "@icp-sdk/core/identity";
import { VaultClient } from "../src/api";
import type { Header, VaultActor } from "../src/contracts";
import {
  aad,
  deriveKey,
  importKey,
  randomBytes,
  seal,
} from "../../vault-crypto/src/index";
import { b64 } from "../../vault-crypto/src/documents";
import { openArchive } from "../../vault-backup/src/index";
async function fixture() {
  const vault = randomBytes(16),
    raw = randomBytes(32),
    secret = randomBytes(32);
  const header: Header = {
    id: vault,
    epoch: 0n,
    sequence: 0n,
    state: { Active: null },
    key_name: "test_key_1",
    backup_sequence: [],
    backup_at: [],
    normal: [
      await seal(
        await importKey(raw),
        raw,
        aad(vault, new Uint8Array(16), 0n, "normal"),
      ),
    ],
    recovery: [
      await seal(
        await deriveKey(secret, "recovery"),
        raw,
        aad(vault, new Uint8Array(16), 0n, "recovery"),
      ),
    ],
  };
  const get_active_export_for_vault = vi.fn(async () => ({ Ok: [] }));
  const derive_vault_key = vi.fn();
  const actor = {
    get_vault_header: vi.fn(async () => ({ Ok: header })),
    get_active_export_for_vault,
    begin_export: vi.fn(async () => ({
      Ok: {
        id: randomBytes(16),
        header,
        vault,
        record_count: 0n,
        chunk_count: 0n,
        plain_bytes: 0n,
      },
    })),
    export_index: vi.fn(async () => ({ Ok: { entries: [], next: [] } })),
    derive_vault_key,
  } as unknown as VaultActor;
  const client = new VaultClient({
    actor,
    identity: Ed25519KeyIdentity.generate(),
    canister: "aaaaa-aa",
    local: true,
  });
  return {
    client,
    actor,
    header,
    raw,
    secret,
    derive_vault_key,
    get_active_export_for_vault,
  };
}
it("builds archive v1 from locked ciphertext and recovery secret without a derive or payer write", async () => {
  const f = await fixture();
  const result = await f.client.backupWithRecovery(f.header, b64(f.secret));
  const archive = await openArchive(result.data, f.secret);
  try {
    expect(archive.rootRaw).toEqual(f.raw);
    expect(archive.header.version).toBe(1);
  } finally {
    archive.rootRaw.fill(0);
  }
  expect(f.client.session.raw).toBeUndefined();
  expect(f.client.session.root).toBeUndefined();
  expect(f.derive_vault_key).not.toHaveBeenCalled();
  expect(f.get_active_export_for_vault).toHaveBeenCalledWith(f.header.id);
});
it("rejects a wrong recovery secret before allocating an export", async () => {
  const f = await fixture();
  await expect(
    f.client.backupWithRecovery(f.header, b64(randomBytes(32))),
  ).rejects.toBeDefined();
  expect(f.actor.begin_export).not.toHaveBeenCalled();
});
it("discards a locked export header that resolves after identity destruction", async () => {
  const f = await fixture();
  let resolve!: (x: { Ok: Header }) => void;
  vi.mocked(f.actor.get_vault_header).mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const pending = f.client.backupWithRecovery(f.header, b64(f.secret));
  f.client.destroy();
  resolve({ Ok: f.header });
  await expect(pending).rejects.toThrow("Locked");
  expect(f.actor.begin_export).not.toHaveBeenCalled();
});
