import { expect, it, vi } from "vitest";
import { Ed25519KeyIdentity } from "@icp-sdk/core/identity";
import { VaultClient } from "../src/api";
import type { Header, VaultActor } from "../src/contracts";
import { importKey } from "../../vault-crypto/src/index";
const header: Header = {
  published_slot: [],
  generation: [],
  recovery_verifier: [],
  id: new Uint8Array(16),
  epoch: 0n,
  sequence: 0n,
  key_name: "test_key_1",
  state: { Active: null },
  normal: [],
  recovery: [],
  backup_at: [],
  backup_sequence: [],
};
it("never starts a write without generation-bound authority", async () => {
  const begin_revision = vi.fn();
  const client = new VaultClient({
    actor: { begin_revision } as unknown as VaultActor,
    identity: Ed25519KeyIdentity.generate(),
    canister: "aaaaa-aa",
    local: true,
  });
  client.header = header;
  client.session.root = await importKey(new Uint8Array(32));
  await expect(
    client.save(
      { kind: "note", title: "Synthetic" },
      new Uint8Array([1]),
      undefined,
      () => {},
    ),
  ).rejects.toThrow("LegacyRecoveryRequired");
  expect(begin_revision).not.toHaveBeenCalled();
});
