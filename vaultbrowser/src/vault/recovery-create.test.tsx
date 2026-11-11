// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Principal } from "@icp-sdk/core/principal";
import { Ed25519KeyIdentity } from "@icp-sdk/core/identity";
import { IDL } from "@icp-sdk/core/candid";
import { VaultClient } from "@kinic/vault-client";
import { CreateEmptyClient } from "@kinic/vault-client/create-empty";
import { mutationIDL } from "@kinic/vault-client/signed";
import type {
  CreateEmptyStatus,
  Generation,
  VaultActor,
} from "@kinic/vault-client/contracts";
import type { Mutation } from "@kinic/vault-client/mutation-contracts";
import { importKey } from "@kinic/vault-crypto";
import { ScopedCreation } from "./recovery-create";
vi.mock("../../../packages/vault-client/src/webauthn", () => ({
  assertCredential: vi.fn(async () => "uv"),
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it.each(["verified", "wrong-file", "lock"])(
  "actual scoped client React save/reselect %s cannot bypass kit confirmation",
  async (mode) => {
    vi.stubGlobal("crypto", webcrypto);
    const identity = Ed25519KeyIdentity.generate(),
      canister = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai"),
      id = new Uint8Array([9]);
    const generation: Generation = {
      version: 2,
      owner: identity.getPrincipal(),
      canister,
      vault: new Uint8Array(16).fill(1),
      nonce: new Uint8Array(32).fill(2),
      epoch: 0n,
      key_name: "test_key_1",
    };
    const state: CreateEmptyStatus = {
      job: new Uint8Array(16).fill(4),
      target: {
        namespace: new Uint8Array(32).fill(3),
        vault: generation.vault,
        attempt: new Uint8Array(16).fill(5),
      },
      creator: {
        credential: id,
        version: 1n,
        scope_digest: new Uint8Array(32),
      },
      generation: [generation],
      authorizer_instance: { ...generation, vault: new Uint8Array(16).fill(6) },
      phase: { Allocated: null },
      normal: [],
      recovery: [],
      recovery_verifier: new Uint8Array(),
      envelope_digest: new Uint8Array(32).fill(7),
      key_digest: new Uint8Array(32),
      kit_ack: [],
      allocation_token: [],
      cleanup_cursor: 0n,
    };
    const ops: string[] = [];
    const actor = {
      create_empty_status: async () => ({ Ok: [{ ...state }] }),
      list_vaults: async () => ({ Ok: [] }),
      incident_context: async () => ({ Ok: [] }),
      begin_grant: async () => ({
        Ok: {
          bytes: new Uint8Array(32),
          expires: 9999999999n,
          registration: false,
          credential_ids: [id],
        },
      }),
      finish_grant: async () => ({
        Ok: {
          id: new Uint8Array(32),
          expires: 9999999999n,
          next_counter: 0n,
          generations: [state.authorizer_instance],
          purpose: { Normal: null },
        },
      }),
      mutate: async (payload: Uint8Array) => {
        const { operation } = IDL.decode(
          [mutationIDL],
          payload,
        )[0] as unknown as Mutation;
        ops.push(Object.keys(operation)[0]);
        if ("CreateEmptyStage" in operation) {
          state.normal = [operation.CreateEmptyStage.normal];
          state.recovery = [operation.CreateEmptyStage.recovery];
          state.recovery_verifier =
            operation.CreateEmptyStage.recovery_verifier;
          state.phase = { EnvelopesStaged: null };
        }
        if ("CreateEmptyConfirmKit" in operation) {
          state.kit_ack = [state.envelope_digest];
          state.phase = { KitConfirmed: null };
        }
        return { Ok: { Unit: null } };
      },
    } as unknown as VaultActor;
    const client = new VaultClient({
        actor,
        identity,
        canister: canister.toText(),
        local: true,
        rpId: "localhost",
      }),
      service = new CreateEmptyClient(
        actor,
        identity.getPrincipal(),
        canister,
        "localhost",
        true,
        client.session,
      );
    Object.assign(service, {
      derive: async () => importKey(new Uint8Array(32).fill(8)),
    });
    let saved = new Uint8Array(),
      pending: Promise<void> | undefined;
    vi.spyOn(client.session, "download").mockImplementation((data) => {
      saved = data.slice();
    });
    render(
      <ScopedCreation
        client={client}
        service={service}
        enabled={true}
        disabled={false}
        credential={id}
        onChanged={async () => {}}
        run={(f) => {
          pending = f().catch(() => {});
        }}
      />,
    );
    await screen.findByRole("button", {
      name: "Save and verify empty Vault kit",
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Save and verify empty Vault kit" }),
    );
    await screen.findByLabelText("Reselect saved empty Vault kit");
    expect(ops).toEqual(["CreateEmptyStage"]);
    expect(saved.length).toBeGreaterThan(0);
    if (mode === "lock") act(() => client.session.lock());
    else
      await act(async () => {
        const data =
          mode === "wrong-file" ? new Uint8Array([1]) : saved.slice();
        fireEvent.change(
          screen.getByLabelText("Reselect saved empty Vault kit"),
          {
            target: {
              files: [
                { size: data.length, arrayBuffer: async () => data.buffer },
              ],
            },
          },
        );
        await pending;
      });
    await act(async () => {
      await pending;
    });
    expect(ops.includes("CreateEmptyConfirmKit")).toBe(mode === "verified");
    expect(ops).not.toContain("CreateEmptyActivate");
    if (mode === "verified")
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Activate new empty Vault" }),
        ).toBeTruthy(),
      );
    if (mode === "wrong-file")
      expect(
        screen.getByRole("button", {
          name: "Resume with saved empty Vault kit",
        }),
      ).toBeTruthy();
    service.destroy();
  },
);
