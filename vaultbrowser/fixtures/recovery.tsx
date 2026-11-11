// Synthetic actor/key-service/WebAuthn boundaries only. Never imported by the product entry.
import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { IDL } from "@icp-sdk/core/candid";
import { Principal } from "@icp-sdk/core/principal";
import { Ed25519KeyIdentity } from "@icp-sdk/core/identity";
import { VaultClient } from "@kinic/vault-client";
import { CreateEmptyClient } from "@kinic/vault-client/create-empty";
import { mutationIDL } from "@kinic/vault-client/signed";
import type { Mutation } from "@kinic/vault-client/mutation-contracts";
import type {
  CreateEmptyStatus,
  Generation,
  GrantRequest,
  Header,
  IncidentStatus,
  VaultActor,
} from "@kinic/vault-client/contracts";
import { importKey } from "@kinic/vault-crypto";
import { VaultRecovery } from "../src/vault/recovery";
import { vaultError, VaultButton } from "../src/vault/ui";
import "../src/style.css";
const id = (n: number, size = 16) => new Uint8Array(size).fill(n),
  identity = Ed25519KeyIdentity.generate(),
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
const source = g(1),
  target = g(2);
let empty: CreateEmptyStatus = {
  job: id(3),
  target: { namespace: id(4, 32), vault: target.vault, attempt: id(5) },
  authorizer_instance: source,
  creator: { credential: id(9), version: 1n, scope_digest: id(1, 32) },
  generation: [target],
  phase: { Allocated: null },
  normal: [],
  recovery: [],
  recovery_verifier: [],
  envelope_digest: id(6, 32),
  kit_ack: [],
  allocation_token: [],
  key_digest: id(7, 32),
  cleanup_cursor: 0n,
};
const header = (generation: Generation): Header => ({
  id: generation.vault,
  generation: [generation],
  state: { Active: null },
  epoch: 0n,
  sequence: 0n,
  key_name: "test_key_1",
  normal: [],
  recovery: [],
  recovery_verifier: [],
  backup_at: [],
  backup_sequence: [],
  published_slot: [],
});
const incident: IncidentStatus = {
  job: id(8),
  namespace: id(4, 32),
  vector_digest: id(1, 32),
  complete: false,
  completed_digest: [],
  cancel_digest: [],
  semantic_config: [],
  compromised: [],
  targets: [source, g(3)].map((generation, i) => ({
    source: header(generation),
    target: [{ ...generation, nonce: id(i + 30, 32), epoch: 1n }],
    attempt: id(i + 20),
    phase: { BackupVerified: null },
    normal: [],
    recovery: [],
    recovery_verifier: [],
    envelope_digest: id(2, 32),
    kit_ack: [id(2, 32)],
    backup_ack: [
      {
        archive_length: 1n,
        archive_hash: id(1, 32),
        descriptor_digest: id(2, 32),
        recovery_verifier: id(3, 32),
        sequence: 0n,
        commitment: id(4, 32),
      },
    ],
    restore_child: [],
    reset_attempt: [],
    staged_export: [],
    coverage: [],
    snapshot_sequence: 0n,
    snapshot_time: 0n,
    next_epoch: 1n,
  })),
};
let request: GrantRequest;
const operations: string[] = [];
const actor = {
  list_vaults: async () => ({ Ok: [header(source)] }),
  incident_context: async () => ({
    Ok: [
      {
        namespace: id(4, 32),
        credentials: [
          {
            credential: id(9),
            version: 1n,
            scope: {
              Instances: [{ vault: source.vault, nonce: source.nonce }],
            },
          },
        ],
      },
    ],
  }),
  create_empty_status: async () => ({ Ok: [empty] }),
  restore_admission_status: async () => ({ Ok: [] }),
  incident_status: async () => ({ Ok: [incident] }),
  begin_grant: async (r: GrantRequest) => {
    request = r;
    return {
      Ok: {
        bytes: id(1, 32),
        expires: 9999999999n,
        registration: false,
        credential_ids: [id(9)],
      },
    };
  },
  finish_grant: async () => ({
    Ok: {
      id: id(2, 32),
      expires: 9999999999n,
      next_counter: 0n,
      generations: request.generations,
      purpose: request.purpose,
    },
  }),
  mutate: async (payload: Uint8Array) => {
    const { operation } = IDL.decode(
      [mutationIDL],
      payload,
    )[0] as unknown as Mutation;
    operations.push(Object.keys(operation)[0]);
    if ("CreateEmptyStage" in operation) {
      empty = {
        ...empty,
        normal: [operation.CreateEmptyStage.normal],
        recovery: [operation.CreateEmptyStage.recovery],
        recovery_verifier: operation.CreateEmptyStage.recovery_verifier,
        phase: { EnvelopesStaged: null },
      };
    }
    if ("CreateEmptyConfirmKit" in operation)
      empty = {
        ...empty,
        kit_ack: [empty.envelope_digest],
        phase: { KitConfirmed: null },
      };
    if ("CreateEmptyActivate" in operation)
      empty = { ...empty, phase: { Active: null } };
    return { Ok: { Unit: null } };
  },
  cancel_create_empty: async () => {
    empty = { ...empty, phase: { Cancelled: null } };
    return { Ok: { job: empty.job, cursor: 0n, complete: true } };
  },
} as unknown as VaultActor;
const client = new VaultClient({
  actor,
  identity,
  canister: canister.toText(),
  local: true,
  rpId: "localhost",
});
Object.assign(CreateEmptyClient.prototype, {
  derive: async () => importKey(id(8, 32)),
});
Object.defineProperty(navigator, "credentials", {
  configurable: true,
  value: {
    get: async () => ({
      rawId: id(9).buffer,
      response: {
        authenticatorData: id(1, 37).buffer,
        clientDataJSON: id(2, 32).buffer,
        signature: id(3, 64).buffer,
        userHandle: null,
      },
    }),
  },
});
Object.assign(window, {
  recoveryFixture: {
    operations,
    session: client.session,
    invalidate: () => {
      incident.targets[1].backup_ack = [];
      incident.targets[1].phase = { Resetting: null };
    },
  },
});
function Fixture() {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    const mode = new URLSearchParams(location.search).get("mode");
    const label =
      mode === "restore"
        ? "Recover after losing all passkeys"
        : mode === "incident"
          ? "Respond to a compromised passkey"
          : mode === "create"
            ? "Create a new empty Vault with scoped access"
            : "";
    const timer = setTimeout(() => {
      if (label)
        [...document.querySelectorAll("button")]
          .find((b) => b.textContent === label)
          ?.click();
    }, 0);
    const clean = client.session.addLockCleanup(() => {
      setBusy(false);
      setError("");
    });
    const hide = () => client.session.lock();
    window.addEventListener("pagehide", hide);
    return () => {
      clearTimeout(timer);
      clean();
      window.removeEventListener("pagehide", hide);
    };
  }, []);
  return (
    <main className="mx-auto grid max-w-5xl gap-4 p-4">
      <h1 className="text-2xl font-semibold">
        Synthetic recovery workflow fixture
      </h1>
      <p>
        Local fake canister and key service; real React, signing, envelope
        crypto, download and file verification. No production authentication.
      </p>
      <VaultButton onClick={() => client.session.lock()}>
        Lock Vault
      </VaultButton>
      {error ? <p role="alert">{error}</p> : null}
      <VaultRecovery
        client={client}
        credential={id(9)}
        enabled
        disabled={busy}
        onChanged={async () => {}}
        run={(f) => {
          const ticket = client.session.capture();
          setBusy(true);
          setError("");
          void f()
            .catch((e) => {
              if (ticket === client.session.capture()) setError(vaultError(e));
            })
            .finally(() => {
              if (ticket === client.session.capture()) setBusy(false);
            });
        }}
      />
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
