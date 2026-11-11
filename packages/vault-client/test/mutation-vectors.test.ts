import { test, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { Ed25519KeyIdentity } from "@icp-sdk/core/identity";
import { Principal } from "@icp-sdk/core/principal";
import { encodeMutation, MUTATION_DOMAIN } from "../src/signed.ts";
import type { MutationOperation } from "../src/mutation-contracts.ts";
import {
  concat,
  generationBytes,
  generationAAD,
  type Generation,
} from "../../vault-crypto/src/index.ts";
import {
  targetRestoreRoot,
  restoreRoot,
  type PortableRecord,
} from "../../vault-backup/src/index.ts";
import { b64 } from "../../vault-crypto/src/documents.ts";
const b = (n: number, len = 16) => new Uint8Array(len).fill(n),
  hex = (x: Uint8Array) => Buffer.from(x).toString("hex");
test("all generated JS Candid mutation variants and generation bytes match frozen Rust vectors", async () => {
  const v = b(1),
    o = b(2),
    op = b(3),
    env = { version: 2, nonce: b(4, 12), ciphertext: b(5, 48) };
  const operations: MutationOperation[] = [
    { Create: { vault: v, operation: op } },
    {
      Activate: {
        request: {
          vault: v,
          attempt: [op],
          operation: b(6),
          normal: env,
          recovery: env,
          registration: [],
          assertion: [],
        },
        recovery_verifier: b(7, 32),
      },
    },
    {
      Derive: {
        vault: v,
        attempt: [],
        epoch: 0n,
        transport: b(8, 48),
        assertion: [],
      },
    },
    { KeyResult: { handle: b(9, 32) } },
    {
      BeginRevision: {
        vault: v,
        object: o,
        expected_revision: 0n,
        operation: op,
        plain_size: 1n,
        manifest: b(10),
        chunk_hashes: [b(11, 32)],
      },
    },
    { PutChunk: { vault: v, upload: op, index: 0, data: b(12) } },
    { CommitRevision: { vault: v, upload: op } },
    {
      DeleteObject: {
        vault: v,
        object: o,
        expected_revision: 1n,
        operation: op,
      },
    },
    { PurgeObject: { vault: v, object: o } },
    { RemoveCredential: { credential: b(13) } },
    { BeginRegistration: { vault: v, scope: { Global: null } } },
    {
      RegisterCredential: {
        vault: v,
        registration: "{}",
        scope: { Instances: [{ vault: v, nonce: b(14, 32) }] },
      },
    },
    { CancelSetup: { vault: v, attempt: op } },
    ...(
      [
        { Purge: null },
        { Expired: null },
        { CancelSetup: { attempt: op } },
        { AbortExport: { export: op } },
        { CancelIncident: { incident: op, vector_digest: b(8, 32) } },
      ] as const
    ).map((action) => ({ Cleanup: { job: op, cursor: 0n, action } })),
  ];
  const generation = {
    version: 2,
    canister: Principal.fromUint8Array(new Uint8Array([1])),
    owner: Principal.fromUint8Array(new Uint8Array([2])),
    vault: v,
    epoch: 1n,
    nonce: b(20, 32),
    key_name: "key_1",
  };
  operations.push(
    { IncidentStart: null },
    { IncidentAllocate: { vault: v, attempt: op } },
    ...([{ Source: null }, { Target: null }] as const).map((role) => ({
      IncidentDerive: {
        job: op,
        attempt: op,
        role,
        generation,
        transport: b(8, 48),
      },
    })),
    {
      IncidentStage: {
        vault: v,
        attempt: op,
        normal: env,
        recovery: env,
        recovery_verifier: b(7, 32),
      },
    },
    {
      IncidentConfirmKit: { vault: v, attempt: op, envelope_digest: b(8, 32) },
    },
    { IncidentReset: { vault: v, attempt: op, next_attempt: b(21) } },
    { IncidentCancel: null },
    {
      IncidentWrap: {
        vault: v,
        attempt: op,
        after: 0n,
        rows: [
          {
            object: o,
            revision: 1n,
            sequence: 1n,
            source_digest: b(8, 32),
            wrapper: b(9),
          },
        ],
      },
    },
    { IncidentPrepareExport: { vault: v, attempt: op, export: b(9) } },
    {
      IncidentConfirmBackup: {
        vault: v,
        attempt: op,
        ack: {
          descriptor_digest: b(8, 32),
          commitment: b(9, 32),
          archive_hash: b(10, 32),
          archive_length: 1000n,
          recovery_verifier: b(7, 32),
          sequence: 2n,
        },
      },
    },
    { IncidentCutover: { digest: b(8, 32) } },
    { ClearInactive: { vault: v } },
  );
  const key = Ed25519KeyIdentity.generate(b(15, 32));
  const owner = Principal.fromUint8Array(new Uint8Array([2])),
    canister = Principal.fromUint8Array(new Uint8Array([1]));
  const vectors = [];
  for (const operation of operations) {
    const payload = encodeMutation({
      version: 2,
      owner,
      canister,
      grant: b(16, 32),
      counter: 0n,
      operation,
    });
    const signature = new Uint8Array(
      await key.sign(new Uint8Array(concat(MUTATION_DOMAIN, payload))),
    );
    vectors.push({
      name: Object.keys(operation)[0],
      payload: hex(payload),
      signature: hex(signature),
    });
  }
  const g: Generation = {
    version: 2,
    canister: canister.toText(),
    owner: owner.toText(),
    vault: b(3),
    epoch: 7n,
    nonce: b(4, 32),
    key_name: "key_1",
  };
  const tombstone: PortableRecord = {
    vault: b64(g.vault),
    object: b64(b(5)),
    revision: "1",
    sequence: "1",
    plain_size: "0",
    manifest: "",
    hashes: [],
    deleted: true,
  };
  const commitments = {
    empty: hex(await targetRestoreRoot(g, [])),
    tombstone: hex(await targetRestoreRoot(g, [tombstone])),
    v1_empty: hex(await restoreRoot([])),
    v1_tombstone: hex(await restoreRoot([tombstone])),
  };
  const result = {
    commitments,
    public_key: hex(key.getPublicKey().rawKey),
    generation: hex(generationBytes(g)),
    aad: hex(generationAAD(g, b(5), 9n, "dek")),
    vectors,
  };
  const path = new URL(
    "../../../crates/vault_service/tests/fixtures/mutation-v2.json",
    import.meta.url,
  );
  if (process.env.WRITE_VAULT_VECTORS)
    writeFileSync(path, JSON.stringify(result, null, 2) + "\n");
  expect(result).toEqual(JSON.parse(readFileSync(path, "utf8")));
});
