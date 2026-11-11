import { expect, it, vi } from "vitest";
import { Ed25519KeyIdentity } from "@icp-sdk/core/identity";
import { VaultClient } from "../src/api";
import type { Header, VaultActor } from "../src/contracts";
import { importKey, verifiedKEK } from "../../vault-crypto/src/index";
vi.mock("../../vault-crypto/src/index.ts", async (original) => ({
  ...(await original<typeof import("../../vault-crypto/src/index.ts")>()),
  verifiedKEK: vi.fn(),
}));
it("verifies a reserved Vault using its persisted old key even after the default key changes", async () => {
  const header: Header = {
  published_slot: [], generation: [], recovery_verifier: [],
    id: new Uint8Array(16),
    epoch: 0n,
    sequence: 0n,
    state: { Pending: null },
    key_name: "test_key_1",
    normal: [],
    recovery: [],
    backup_sequence: [],
    backup_at: [],
  };
  vi.mocked(verifiedKEK).mockResolvedValue(await importKey(new Uint8Array(32)));
  const actor = {
    reserve_vault: vi.fn(async () => ({ Ok: header })),
    derive_vault_key: vi.fn(async () => ({
      Ok: { encrypted_key: new Uint8Array(), public_key: new Uint8Array() },
    })),
    get_config: vi.fn(async () => ({ Ok: [{ key_name: "key_1" }] })),
  } as unknown as VaultActor;
  const identity = Ed25519KeyIdentity.generate();
  const client = new VaultClient({
    actor,
    identity,
    canister: "aaaaa-aa",
    local: true,
  });
  await client.createKit();
  expect(verifiedKEK).toHaveBeenCalledWith(
    expect.any(Uint8Array),
    expect.anything(),
    "aaaaa-aa",
    expect.any(Uint8Array),
    0n,
    true,
    identity.getPrincipal().toUint8Array(),
    "test_key_1",
  );
  client.destroy();
});
