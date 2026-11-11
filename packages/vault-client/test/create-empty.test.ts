import { expect, it, vi } from "vitest";
import { Principal } from "@icp-sdk/core/principal";
import { CreateEmptyClient } from "../src/create-empty";
import {
  cryptoGeneration,
  encodeIncidentKit,
  verifyIncidentKit,
} from "../src/incident";
import { assertCredential } from "../src/webauthn";
import type {
  CreateEmptyStatus,
  Generation,
  VaultActor,
} from "../src/contracts";
import {
  randomBytes,
  importKey,
  deriveKey,
  sealV2,
  generationAAD,
  recoveryVerifier,
} from "../../vault-crypto/src/index";
vi.mock("../src/webauthn", () => ({ assertCredential: vi.fn() }));
const b = (n: number, len = 16) => new Uint8Array(len).fill(n);
async function fixture() {
  const g: Generation = {
    version: 2,
    owner: Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai"),
    canister: Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai"),
    vault: b(2),
    nonce: randomBytes(32),
    epoch: 0n,
    key_name: "key_1",
  };
  const raw = randomBytes(32),
    secret = randomBytes(32),
    kek = await importKey(randomBytes(32)),
    cg = cryptoGeneration(g);
  const normal = await sealV2(kek, raw, generationAAD(cg, b(0), 0n, "normal"));
  const recovery = await sealV2(
    await deriveKey(secret, "recovery"),
    raw,
    generationAAD(cg, b(0), 0n, "recovery"),
  );
  const j = {
    job: b(3),
    target: { namespace: b(4, 32), vault: g.vault, attempt: b(5) },
    authorizer_instance: { ...g, vault: b(1) },
    creator: { credential: b(6), version: 1n, scope_digest: b(7, 32) },
    key_digest: b(8, 32),
    phase: { EnvelopesStaged: null },
    generation: [g],
    normal: [normal],
    recovery: [recovery],
    recovery_verifier: await recoveryVerifier(secret),
    envelope_digest: b(9, 32),
    kit_ack: [],
    allocation_token: [],
    cleanup_cursor: 0n,
  } as CreateEmptyStatus;
  return { g, j, raw, secret, kek };
}
it("reopens both new empty envelopes with the saved exact-generation kit and rejects old source kit", async () => {
  const { g, j, raw, secret, kek } = await fixture();
  const target = {
    target: j.generation,
    normal: j.normal,
    recovery: j.recovery,
    recovery_verifier: j.recovery_verifier,
  };
  expect(
    await verifyIncidentKit(target, kek, encodeIncidentKit(g, secret)),
  ).toEqual(raw);
  await expect(
    verifyIncidentKit(
      target,
      kek,
      encodeIncidentKit({ ...g, nonce: b(77, 32) }, secret),
    ),
  ).rejects.toThrow("InvalidKit");
  await expect(
    verifyIncidentKit(target, kek, encodeIncidentKit(g, randomBytes(32))),
  ).rejects.toThrow("VerifierMismatch");
  const corrupt = {
    ...target,
    recovery: [
      { ...j.recovery[0]!, ciphertext: b(9, 48) },
    ] as typeof j.recovery,
  };
  await expect(
    verifyIncidentKit(corrupt, kek, encodeIncidentKit(g, secret)),
  ).rejects.toThrow();
});
it("binds scoped UV to the exact source/job/new target, never requests registration or empty generations", async () => {
  const { g, j } = await fixture(),
    seen: any[] = [];
  vi.mocked(assertCredential).mockResolvedValue("uv");
  const actor = {
    begin_grant: vi.fn(async (r: any) => {
      seen.push(r);
      return {
        Ok: {
          bytes: b(1, 32),
          expires: 9999999999n,
          registration: false,
          credential_ids: [b(6)],
        },
      };
    }),
    finish_grant: vi.fn(async () => ({
      Ok: {
        id: b(9, 32),
        expires: 9999999999n,
        next_counter: 0n,
        purpose: seen[0].purpose,
        generations: [j.authorizer_instance],
      },
    })),
    create_empty_status: vi.fn(async () => ({ Ok: [j] })),
  } as unknown as VaultActor;
  const client = new CreateEmptyClient(
    actor,
    g.owner,
    g.canister,
    "localhost",
    true,
  );
  await client.authenticate(b(6), b(3), j.target, j.authorizer_instance);
  expect(seen[0].generations).toEqual([j.authorizer_instance]);
  expect(seen[0].purpose).toEqual({
    CreateEmpty: {
      job: b(3),
      target: j.target,
      authorizer_instance: j.authorizer_instance,
    },
  });
  client.session.lock();
  await expect(client.activate()).rejects.toThrow("FreshScopedProofRequired");
});
it("cancels only the status-bound exact job/attempt/generation/cursor without key allocation", async () => {
  const { g, j } = await fixture();
  const cancel = vi.fn(async () => ({
    Ok: { job: j.job, cursor: 1n, complete: true },
  }));
  const actor = {
    create_empty_status: vi.fn(async () => ({ Ok: [j] })),
    cancel_create_empty: cancel,
  } as unknown as VaultActor;
  const client = new CreateEmptyClient(
    actor,
    g.owner,
    g.canister,
    "localhost",
    true,
  );
  await client.cancel();
  expect(cancel).toHaveBeenCalledWith(j.job, j.target, j.generation, 0n);
});
it("a lock during the UV prompt prevents finishing the grant", async () => {
  const { g, j } = await fixture();
  let client: CreateEmptyClient;
  vi.mocked(assertCredential).mockImplementation(async () => {
    client.session.lock();
    return "uv";
  });
  const finish = vi.fn(),
    actor = {
      begin_grant: vi.fn(async () => ({
        Ok: {
          bytes: b(1, 32),
          expires: 9999999999n,
          registration: false,
          credential_ids: [b(6)],
        },
      })),
      finish_grant: finish,
    } as unknown as VaultActor;
  client = new CreateEmptyClient(actor, g.owner, g.canister, "localhost", true);
  await expect(
    client.authenticate(
      b(6),
      j.job as Uint8Array,
      j.target,
      j.authorizer_instance,
    ),
  ).rejects.toThrow();
  expect(finish).not.toHaveBeenCalled();
});

it.each([
  "saved",
  "reject-save",
  "wrong-kit",
  "lock-save",
  "lock-reselect",
  "changed-readback",
])(
  "direct prepare save/reselect/readback %s never confirms before verification",
  async (mode) => {
    const { g, j, kek } = await fixture();
    j.phase = { Allocated: null };
    let saved = new Uint8Array(),
      selected = new Uint8Array();
    const operations: string[] = [];
    const client = new CreateEmptyClient(
      {
        create_empty_status: async () => ({
          Ok: [{ ...j, target: { ...j.target } }],
        }),
      } as unknown as VaultActor,
      g.owner,
      g.canister,
      "localhost",
      true,
    );
    const send = async (op: any) => {
      operations.push(Object.keys(op)[0]);
      if (op.CreateEmptyStage) {
        j.normal = [op.CreateEmptyStage.normal];
        j.recovery = [op.CreateEmptyStage.recovery];
        j.recovery_verifier = op.CreateEmptyStage.recovery_verifier;
        j.phase = { EnvelopesStaged: null };
        if (mode === "changed-readback") j.target.attempt = b(99);
      }
      if (op.CreateEmptyConfirmKit) j.phase = { KitConfirmed: null };
      return { Unit: null };
    };
    Object.assign(client, {
      derive: async () => kek,
      signer: { send, destroy: () => {} },
    });
    const pending = client.prepare(
      async (x) => {
        saved = x.slice();
        if (mode === "reject-save") throw Error("save rejected");
        if (mode === "lock-save") client.session.lock();
      },
      async () => {
        selected =
          mode === "wrong-kit"
            ? encodeIncidentKit(g, randomBytes(32))
            : saved.slice();
        if (mode === "lock-reselect") client.session.lock();
        return selected;
      },
    );
    if (mode === "saved") await pending;
    else await expect(pending).rejects.toThrow();
    expect(operations.includes("CreateEmptyConfirmKit")).toBe(mode === "saved");
    if (selected.length) expect(selected.every((x) => x === 0)).toBe(true);
  },
);
it("confirmSavedKit reopens staged envelopes and fences a late derive after lock", async () => {
  const { g, j, kek, secret } = await fixture();
  const send = vi.fn(async () => ({ Unit: null }));
  const client = new CreateEmptyClient(
    {
      create_empty_status: async () => ({
        Ok: [{ ...j, target: { ...j.target } }],
      }),
    } as unknown as VaultActor,
    g.owner,
    g.canister,
    "localhost",
    true,
  );
  Object.assign(client, {
    derive: async () => kek,
    signer: { send, destroy: () => {} },
  });
  await client.confirmSavedKit(encodeIncidentKit(g, secret));
  expect(send).toHaveBeenCalledWith({
    CreateEmptyConfirmKit: { envelope_digest: j.envelope_digest },
  });
  send.mockClear();
  Object.assign(client, {
    derive: async () => {
      client.session.lock();
      return kek;
    },
  });
  await expect(
    client.confirmSavedKit(encodeIncidentKit(g, secret)),
  ).rejects.toThrow("Locked");
  expect(send).not.toHaveBeenCalled();
});

it("reuses exact scoped creation authority but renews on target, key version, scope or lock", async () => {
  const { g, j } = await fixture();
  j.creator = { credential: b(6), version: 1n, scope_digest: b(8, 32) };
  j.key_digest = b(7, 32);
  vi.mocked(assertCredential).mockResolvedValue("uv");
  let request: any;
  const begin = vi.fn(async (r: any) => {
    request = r;
    return {
      Ok: {
        bytes: b(1, 32),
        expires: 9999999999n,
        registration: false,
        credential_ids: [b(6)],
      },
    };
  });
  const actor = {
    begin_grant: begin,
    finish_grant: async () => ({
      Ok: {
        id: b(9, 32),
        expires: 9999999999n,
        next_counter: 0n,
        purpose: request.purpose,
        generations: request.generations,
      },
    }),
    create_empty_status: async () => ({ Ok: [j] }),
  } as unknown as VaultActor;
  const client = new CreateEmptyClient(
    actor,
    g.owner,
    g.canister,
    "localhost",
    true,
  );
  const ensure = () =>
    client.ensureAuthenticated(
      b(6),
      new Uint8Array(j.job),
      j.target,
      j.authorizer_instance,
    );
  await ensure();
  await ensure();
  expect(begin).toHaveBeenCalledTimes(1);
  j.phase = { KitConfirmed: null };
  await ensure();
  expect(begin).toHaveBeenCalledTimes(1);
  j.generation = [{ ...g, nonce: b(10, 32) }];
  await ensure();
  expect(begin).toHaveBeenCalledTimes(2);
  j.creator.version++;
  await ensure();
  expect(begin).toHaveBeenCalledTimes(3);
  j.creator.scope_digest = b(11, 32);
  await ensure();
  expect(begin).toHaveBeenCalledTimes(4);
  client.session.lock();
  await ensure();
  expect(begin).toHaveBeenCalledTimes(5);
  client.destroy();
});
