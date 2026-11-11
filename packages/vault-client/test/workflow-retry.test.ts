import { expect, it, vi } from "vitest";
import { Principal } from "@icp-sdk/core/principal";
import { IncidentClient } from "../src/incident";
import { RestoreClient } from "../src/restore";
import { CreateEmptyClient } from "../src/create-empty";
import type { Generation, VaultActor } from "../src/contracts";
vi.mock("../src/webauthn", () => ({
  assertCredential: vi.fn(async () => "uv"),
}));
it.each(["incident", "restore", "create"] as const)(
  "%s preserves exact unresolved signed bytes across attempts to acquire new authority",
  async (kind) => {
    const owner = Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai"),
      canister = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai"),
      credential = new Uint8Array([9]),
      job = new Uint8Array(16),
      target = {
        namespace: new Uint8Array(32),
        vault: new Uint8Array(16),
        attempt: new Uint8Array(16),
      };
    const generation: Generation = {
      version: 2,
      owner,
      canister,
      vault: target.vault,
      nonce: new Uint8Array(32),
      epoch: 0n,
      key_name: "test_key_1",
    };
    let grants = 0,
      uncertain = true;
    const sent: { payload: Uint8Array; signature: Uint8Array }[] = [];
    const begin = async () => {
      grants++;
      return {
        Ok: {
          bytes: new Uint8Array(32),
          expires: 9999999999n,
          registration: false,
          credential_ids: [credential],
        },
      };
    };
    const finish = async () => ({
      Ok: {
        id: new Uint8Array(32),
        expires: 9999999999n,
        next_counter: 0n,
        purpose: { Normal: null },
        generations: [],
      },
    });
    const actor = {
      begin_grant: begin,
      finish_grant: finish,
      begin_restore_grant: begin,
      finish_restore_grant: finish,
      create_empty_status: async () => ({ Ok: [{}] }),
      mutate: async (payload: Uint8Array, signature: Uint8Array) => {
        sent.push({ payload: payload.slice(), signature: signature.slice() });
        if (uncertain) throw Error("network");
        return { Ok: { Unit: null } };
      },
    } as unknown as VaultActor;
    const client =
      kind === "incident"
        ? new IncidentClient(actor, owner, canister, "localhost", true)
        : kind === "restore"
          ? new RestoreClient(actor, owner, canister, "localhost", true)
          : new CreateEmptyClient(actor, owner, canister, "localhost", true);
    const authenticate = () =>
      client instanceof IncidentClient
        ? client.authenticate(credential, { Normal: null }, [])
        : client instanceof RestoreClient
          ? client.authenticate(credential, { RestorePrepare: { job, target } })
          : client.authenticate(credential, job, target, generation);
    await authenticate();
    await expect(
      client instanceof IncidentClient ? client.start() : client.allocate(),
    ).rejects.toThrow("network");
    await expect(authenticate()).rejects.toThrow("ResolvePendingMutation");
    expect(grants).toBe(1);
    if (client instanceof IncidentClient) {
      await expect(
        client.ensureAuthenticated(credential, { Normal: null }, []),
      ).rejects.toThrow("ResolvePendingMutation");
      await expect(client.cutover(credential)).rejects.toThrow(
        "ResolvePendingMutation",
      );
      await expect(client.cancel(credential, job)).rejects.toThrow(
        "ResolvePendingMutation",
      );
    } else if (client instanceof RestoreClient) {
      await expect(
        client.ensureAuthenticated(credential, {
          RestorePrepare: { job, target },
        }),
      ).rejects.toThrow("ResolvePendingMutation");
      await expect(
        client.ensureResumed(new Uint8Array(), new Uint8Array()),
      ).rejects.toThrow("ResolvePendingMutation");
    } else
      await expect(
        client.ensureAuthenticated(credential, job, target, generation),
      ).rejects.toThrow("ResolvePendingMutation");
    if (client instanceof RestoreClient) {
      await expect(
        client.admit(
          target.namespace,
          new Uint8Array(),
          new Uint8Array(),
          async () => {},
        ),
      ).rejects.toThrow("ResolvePendingMutation");
      await expect(
        client.resume(new Uint8Array(), new Uint8Array()),
      ).rejects.toThrow("ResolvePendingMutation");
    }
    uncertain = false;
    await client.retry();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    await authenticate();
    expect(grants).toBe(2);
    client.destroy();
  },
);
