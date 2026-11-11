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
import { IDL } from "@icp-sdk/core/candid";
import { VaultClient } from "@kinic/vault-client";
import { IncidentClient } from "@kinic/vault-client/incident";
import { mutationIDL } from "@kinic/vault-client/signed";
import type {
  Generation,
  Header,
  IncidentStatus,
  VaultActor,
  GrantRequest,
  IncidentTarget,
} from "@kinic/vault-client/contracts";
import type { Mutation } from "@kinic/vault-client/mutation-contracts";
import { IncidentRecovery } from "./recovery-incident";
vi.mock("../../../packages/vault-client/src/webauthn", () => ({
  assertCredential: vi.fn(async () => "uv"),
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const id = (n: number, size = 16) => new Uint8Array(size).fill(n);
async function fixture() {
  vi.stubGlobal("crypto", webcrypto);
  const identity = Ed25519KeyIdentity.generate(),
    canister = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai");
  const g = (n: number): Generation => ({
    version: 2,
    owner: identity.getPrincipal(),
    canister,
    vault: id(n),
    nonce: id(n, 32),
    epoch: 0n,
    key_name: "test_key_1",
  });
  const headers = [1, 2, 3].map(
    (n) =>
      ({
        id: id(n),
        generation: [g(n)],
        epoch: 0n,
        sequence: 0n,
        key_name: "test_key_1",
        state: { Active: null },
        normal: [],
        recovery: [],
        recovery_verifier: [],
        published_slot: [],
        backup_at: [],
        backup_sequence: [],
      }) as Header,
  );
  let status: IncidentStatus | undefined;
  let request: GrantRequest | undefined;
  const operations: string[] = [];
  const actor = {
    list_vaults: async () => ({ Ok: headers }),
    incident_status: async () => ({ Ok: status ? [status] : [] }),
    incident_context: async () => ({
      Ok: [
        {
          namespace: id(9, 32),
          credentials: [
            { credential: id(7), version: 1n, scope: { Global: null } },
            {
              credential: id(8),
              version: 2n,
              scope: {
                Instances: [
                  { vault: id(1), nonce: id(1, 32) },
                  { vault: id(2), nonce: id(2, 32) },
                ],
              },
            },
          ],
        },
      ],
    }),
    begin_grant: async (r: GrantRequest) => {
      request = r;
      return {
        Ok: {
          bytes: id(1, 32),
          expires: 9999999999n,
          registration: false,
          credential_ids: [id(7)],
        },
      };
    },
    finish_grant: async () => ({
      Ok: {
        id: id(1, 32),
        expires: 9999999999n,
        next_counter: 0n,
        generations: request!.generations,
        purpose: request!.purpose,
      },
    }),
    mutate: async (payload: Uint8Array) => {
      const m = IDL.decode([mutationIDL], payload)[0] as unknown as Mutation;
      operations.push(Object.keys(m.operation)[0]);
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
    service = new IncidentClient(
      actor,
      identity.getPrincipal(),
      canister,
      "localhost",
      true,
      client.session,
    );
  return {
    client,
    service,
    headers,
    operations,
    request: () => request,
    setStatus: (s: IncidentStatus) => {
      status = s;
    },
  };
}
it("scoped compromised key freezes the exact entire affected vector in one signed incident request", async () => {
  const f = await fixture();
  vi.spyOn(window, "confirm").mockReturnValue(true);
  let pending: Promise<void> | undefined;
  render(
    <IncidentRecovery
      client={f.client}
      service={f.service}
      credential={id(7)}
      enabled={true}
      disabled={false}
      onChanged={async () => {}}
      run={(fn) => {
        pending = fn();
      }}
    />,
  );
  await screen.findByLabelText("Passkey 2 · scoped instances");
  fireEvent.click(screen.getByLabelText("Passkey 2 · scoped instances"));
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", {
        name: "Revoke and freeze all affected Vaults",
      }),
    );
    await pending;
  });
  expect(f.operations).toEqual(["IncidentStart"]);
  const r = f.request()!;
  expect(r.generations.map((g) => Array.from(g.vault))).toEqual([
    Array(16).fill(1),
    Array(16).fill(2),
  ]);
  expect("IncidentPrepare" in r.purpose).toBe(true);
  if ("IncidentPrepare" in r.purpose) {
    expect(r.purpose.IncidentPrepare.targets).toHaveLength(2);
    expect(r.purpose.IncidentPrepare.compromised).toEqual([
      { credential: id(8), version: 2n },
    ]);
  }
  f.service.destroy();
});
it.each(["missing", "reset", "child", "purging", "purged-child"])(
  "requires all unresolved incident targets to be verified with %s original state",
  async (mode) => {
    const f = await fixture();
    const target = (i: number) =>
      ({
        source: f.headers[i],
        attempt: id(i + 10),
        target: [
          { ...f.headers[i].generation[0]!, nonce: id(i + 20, 32), epoch: 1n },
        ],
        phase: { BackupVerified: null },
        backup_ack: [{}],
        normal: [],
        recovery: [],
        kit_ack: [id(1, 32)],
        envelope_digest: id(1, 32),
        recovery_verifier: id(1, 32),
        coverage: [],
        staged_export: [],
        restore_child: [],
        reset_attempt: [],
        snapshot_sequence: 0n,
        snapshot_time: 0n,
        next_epoch: 1n,
      }) as unknown as IncidentTarget;
    const targets = [target(0), target(1), target(2)];
    if (mode === "missing") targets[1].backup_ack = [];
    if (mode === "reset") targets[1].phase = { Resetting: null };
    if (["child", "purging", "purged-child"].includes(mode)) {
      targets[0].restore_child = [
        {
          job: id(40),
          attempt: id(41),
          archive_digest: id(42, 32),
          target: {
            ...f.headers[0].generation[0]!,
            nonce: id(43, 32),
            epoch: 1n,
          },
        },
      ];
    }
    if (mode === "purging" || mode === "purged-child") {
      targets[0].phase =
        mode === "purging" ? { Purging: null } : { Purged: null };
      targets[0].backup_ack = [];
      targets[0].kit_ack = [];
      targets[0].target = [];
    }
    f.setStatus({
      job: id(2),
      namespace: id(9, 32),
      vector_digest: id(5, 32),
      complete: false,
      completed_digest: [],
      cancel_digest: [],
      compromised: [],
      semantic_config: [],
      targets,
    });
    render(
      <IncidentRecovery
        client={f.client}
        service={f.service}
        credential={id(7)}
        enabled={true}
        disabled={false}
        onChanged={async () => {}}
        run={(fn) => {
          void fn();
        }}
      />,
    );
    const button = await screen.findByRole("button", {
      name: "Commit all verified targets with fresh passkey proof",
    });
    expect((button as HTMLButtonElement).disabled).toBe(
      mode !== "purged-child",
    );
    expect(screen.queryByText(/All incident targets committed/)).toBeNull();
    expect(f.operations).toEqual([]);
    if (mode === "purged-child")
      expect(targets[0].phase).toEqual({ Purged: null });
    f.service.destroy();
  },
);
