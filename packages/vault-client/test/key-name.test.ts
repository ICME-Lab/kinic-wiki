import { expect, it, vi } from "vitest";
import { Ed25519KeyIdentity } from "@icp-sdk/core/identity";
import { Principal } from "@icp-sdk/core/principal";
import { IDL } from "@icp-sdk/core/candid";
import type { Mutation } from "../src/mutation-contracts";
import { mutationIDL } from "../src/signed";
import { VaultClient } from "../src/api";
import type { Header, VaultActor } from "../src/contracts";
import {
  importKey,
  verifiedGenerationKEK,
  openV2,
  generationAAD,
  deriveKey,
} from "../../vault-crypto/src/index";
vi.mock("../../vault-crypto/src/index.ts", async (original) => ({
  ...(await original<typeof import("../../vault-crypto/src/index.ts")>()),
  verifiedGenerationKEK: vi.fn(),
}));
vi.mock("../src/webauthn", () => ({
  register: vi.fn(async () => "registration"),
  assertCredential: vi.fn(async () => "proof"),
}));
import { unb64 } from "../../vault-crypto/src/documents";
it("bootstraps, confirms and unlocks generation-bound envelopes using the persisted key anchor", async () => {
  const identity = Ed25519KeyIdentity.generate(),
    canister = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai");
  const generation = {
    version: 2,
    canister,
    owner: identity.getPrincipal(),
    vault: new Uint8Array(16),
    nonce: new Uint8Array(32).fill(1),
    epoch: 0n,
    key_name: "test_key_1",
  };
  const header: Header = {
    published_slot: [],
    generation: [generation],
    recovery_verifier: [],
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
  vi.mocked(verifiedGenerationKEK).mockResolvedValue(
    await importKey(new Uint8Array(32)),
  );
  let active = header;
  const actor = {
    list_credentials: vi.fn(async () => ({ Ok: [] })),
    bootstrap: vi.fn(async () => ({
      Ok: {
        header,
        challenge: {
          registration: true,
          bytes: new Uint8Array(32),
          credential_ids: [],
          expires: 9999999999n,
        },
      },
    })),
    register_bootstrap: vi.fn(async () => ({
      Ok: {
        id: new Uint8Array(32),
        expires: 9999999999n,
        next_counter: 0n,
        purpose: { Normal: null },
        generations: [generation],
      },
    })),
    mutate: vi.fn(async (payload) => {
      const m = IDL.decode([mutationIDL], payload)[0] as unknown as Mutation;
      if ("Activate" in m.operation) {
        active = {
          ...header,
          state: { Active: null },
          normal: [m.operation.Activate.request.normal],
          recovery: [m.operation.Activate.request.recovery],
          recovery_verifier: m.operation.Activate.recovery_verifier,
        };
        return { Ok: { Header: active } };
      }
      return {
        Ok:
          "Derive" in m.operation
            ? { Handle: new Uint8Array(32) }
            : {
                Key: {
                  encrypted_key: new Uint8Array(),
                  public_key: new Uint8Array(),
                },
              },
      };
    }),
    get_vault_header: vi.fn(async () => ({ Ok: active })),
    begin_grant: vi.fn(async () => ({
      Ok: {
        registration: false,
        bytes: new Uint8Array(32),
        credential_ids: [new Uint8Array([9])],
        expires: 9999999999n,
      },
    })),
    finish_grant: vi.fn(async () => ({
      Ok: {
        id: new Uint8Array(32),
        expires: 9999999999n,
        next_counter: 0n,
        purpose: { Normal: null },
        generations: [generation],
      },
    })),
    get_config: vi.fn(async () => ({ Ok: [{ key_name: "key_1" }] })),
  } as unknown as VaultActor;
  const client = new VaultClient({
    actor,
    identity,
    canister: canister.toText(),
    local: true,
  });
  const kit = await client.createKit(),
    original = client.session.raw!.slice();
  const cg = {
    ...generation,
    version: 2 as const,
    owner: identity.getPrincipal().toText(),
    canister: canister.toText(),
  };
  expect(
    await openV2(
      await importKey(new Uint8Array(32)),
      kit.normal,
      generationAAD(cg, new Uint8Array(16), 0n, "normal"),
    ),
  ).toEqual(original);
  expect(
    await openV2(
      await deriveKey(unb64(kit.secret), "recovery"),
      kit.recovery,
      generationAAD(cg, new Uint8Array(16), 0n, "recovery"),
    ),
  ).toEqual(original);
  await expect(client.activate(kit, "wrong")).rejects.toThrow(
    "RecoveryConfirmationMismatch",
  );
  await client.activate(kit, kit.secret);
  vi.mocked(actor.list_credentials).mockResolvedValue({
    Ok: [{ id: new Uint8Array([9]) }],
  });
  await client.unlock(active);
  expect(client.session.raw).toEqual(original);
  original.fill(0);
  expect(verifiedGenerationKEK).toHaveBeenCalledWith(
    expect.any(Uint8Array),
    expect.anything(),
    expect.objectContaining({
      key_name: "test_key_1",
      canister: canister.toText(),
      owner: identity.getPrincipal().toText(),
    }),
    true,
  );
  client.destroy();
});
