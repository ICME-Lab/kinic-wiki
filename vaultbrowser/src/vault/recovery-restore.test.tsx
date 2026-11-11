// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Principal } from "@icp-sdk/core/principal";
import { Ed25519KeyIdentity } from "@icp-sdk/core/identity";
import { VaultClient } from "@kinic/vault-client";
import { RestoreClient } from "@kinic/vault-client/restore";
import type {
  RestoreAdmissionRequest,
  RestoreAdmissionStatus,
  VaultActor,
} from "@kinic/vault-client/contracts";
import { aad, deriveKey, seal, randomBytes } from "@kinic/vault-crypto";
import { b64, pack } from "@kinic/vault-crypto/documents";
import { makeArchive } from "@kinic/vault-backup";
import { BackupRestore } from "./recovery-restore";
vi.mock("../../../packages/vault-client/src/webauthn", () => ({
  assertCredential: vi.fn(async () => "uv"),
  register: vi.fn(async () => "registration"),
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it.each(["valid", "malformed", "locked"])(
  "actual RestoreClient legacy React source %s fully validates before admission",
  async (mode) => {
    vi.stubGlobal("crypto", webcrypto);
    const identity = Ed25519KeyIdentity.generate(),
      canister = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai"),
      secret = randomBytes(32),
      vault = randomBytes(16),
      raw = randomBytes(32);
    const recovery = pack(
      await seal(
        await deriveKey(secret, "recovery"),
        raw,
        aad(vault, new Uint8Array(16), 0n, "recovery"),
      ),
    );
    const archive = await makeArchive(
      {
        version: 1,
        vault: b64(vault),
        epoch: "0",
        sequence: "0",
        key_name: "test_key_1",
        record_count: 0,
        chunk_count: 0,
        plain_bytes: "0",
        normal: recovery,
        recovery,
      },
      [],
      async () => new Uint8Array(),
      raw,
    );
    raw.fill(0);
    let status: RestoreAdmissionStatus | undefined,
      request: RestoreAdmissionRequest | undefined,
      pending: Promise<void> | undefined;
    const ch = {
      bytes: randomBytes(32),
      expires: 9999999999n,
      registration: false,
      credential_ids: [new Uint8Array([1])],
    };
    const actor = {
      incident_context: async () => ({ Ok: [] }),
      list_vaults: async () => ({ Ok: [] }),
      restore_admission_status: async () => ({ Ok: status ? [status] : [] }),
      initialize_restore_namespace: async () => ({ Ok: randomBytes(32) }),
      begin_restore_admission: async (r: RestoreAdmissionRequest) => {
        request = r;
        return { Ok: { ...ch, registration: true } };
      },
      register_restore_candidate: async () => ({ Ok: ch }),
      prove_restore_candidate: async () => {
        status = {
          request: request!,
          challenge: ch,
          current_live: [],
          pipeline: [],
          phase: { Admitted: null },
          cancel_complete: false,
          current_verifier: [],
          semantic_config: [],
          recovery_message: [],
          existing_candidate: [],
          allocation_token: [],
          issued: 0n,
          candidate: ["public candidate"],
          candidate_digest: [],
          proof_fence: [],
          cancel_requested: false,
          next_epoch: 1n,
          parent_job: [],
        };
        return { Ok: status };
      },
    } as unknown as VaultActor;
    const client = new VaultClient({
        actor,
        identity,
        canister: canister.toText(),
        local: true,
        rpId: "localhost",
      }),
      service = new RestoreClient(
        actor,
        identity.getPrincipal(),
        canister,
        "localhost",
        true,
        client.session,
      );
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(
      <BackupRestore
        client={client}
        service={service}
        enabled
        disabled={false}
        onChanged={async () => {}}
        run={(f) => {
          pending = f().catch(() => {});
        }}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.change(screen.getByLabelText("Source recovery format"), {
      target: { value: "legacy" },
    });
    fireEvent.change(screen.getByLabelText("Original legacy recovery secret"), {
      target: { value: mode === "malformed" ? "!" : b64(secret) },
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "Select source backup and recovery kit",
      }),
    );
    await screen.findByLabelText("Select source encrypted backup");
    if (mode === "locked") act(() => client.session.lock());
    else
      await act(async () => {
        fireEvent.change(
          screen.getByLabelText("Select source encrypted backup"),
          {
            target: {
              files: [
                {
                  size: archive.length,
                  arrayBuffer: async () => archive.slice().buffer,
                },
              ],
            },
          },
        );
        await pending;
      });
    await act(async () => {
      await pending;
    });
    if (mode === "valid") {
      expect(request?.source_generation).toEqual([]);
      expect(request?.source_epoch).toBe(0n);
      expect(request?.records).toBe(0n);
      expect(
        screen.getByRole("button", {
          name: "Allocate fresh restoration target",
        }),
      ).toBeTruthy();
      expect(
        screen.queryByRole("button", {
          name: "Activate verified scoped restoration",
        }),
      ).toBeNull();
      const freshResume = vi
        .spyOn(service, "resume")
        .mockResolvedValue(status!);
      const freshAuthenticate = vi
        .spyOn(service, "authenticate")
        .mockResolvedValue(undefined);
      const ensureResume = vi.spyOn(service, "ensureResumed");
      fireEvent.click(
        screen.getByRole("button", {
          name: "Resume restoration with source files and fresh proof",
        }),
      );
      await screen.findByLabelText("Select source encrypted backup");
      await act(async () => {
        fireEvent.change(
          screen.getByLabelText("Select source encrypted backup"),
          {
            target: {
              files: [
                {
                  size: archive.length,
                  arrayBuffer: async () => archive.slice().buffer,
                },
              ],
            },
          },
        );
        await pending;
      });
      expect(freshResume).toHaveBeenCalledTimes(1);
      expect(freshAuthenticate).toHaveBeenCalledTimes(1);
      expect(ensureResume).not.toHaveBeenCalled();
    } else expect(request).toBeUndefined();
    service.destroy();
    secret.fill(0);
  },
);
