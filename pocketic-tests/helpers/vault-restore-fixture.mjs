import { b, cat, hash, b64, key, ok, passkeys } from "./vault-passkeys.mjs";
import { startVaultPocketIc } from "./vault-pocketic-server.mjs";
import { createVaultPocketIcWithTestKeys } from "./vault-pocketic-test-keys.mjs";
// Real dedicated Wasm protocol fixture. Only an isolated synthetic ledger is used.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { encryptDocument } from "../../packages/vault-crypto/src/documents.ts";
import { fileURLToPath } from "node:url";
import { sign } from "node:crypto";
import { idlFactory as vaultIDL } from "../../packages/vault-candid/index.js";
import { idlFactory as mutationFactory } from "../../packages/vault-candid/mutation.js";
const root = fileURLToPath(new URL("../../", import.meta.url));

const local = createRequire(new URL("../package.json", import.meta.url));
const req = createRequire(realpathSync(local.resolve("@dfinity/pic")));
const { PocketIc, PocketIcServer } = req("@dfinity/pic"),
  { IDL } = req("@icp-sdk/core/candid"),
  { Principal } = req("@icp-sdk/core/principal");
if (process.env.POCKET_IC_BIN)
  PocketIcServer.getBinPath = () => process.env.POCKET_IC_BIN;
const owner = Principal.selfAuthenticating(b(90, 32)),
  other = Principal.selfAuthenticating(b(91, 32));
const { registration, assertion } = passkeys(owner, { monotonicCounter: true });
const mutationType = mutationFactory({ IDL })._fields.find(
  ([n]) => n === "encode",
)[1].argTypes[0];

const cryptoLib = await import(
  new URL("../../packages/vault-crypto/src/index.ts", import.meta.url)
);
const {
  TransportSecretKey,
  verifiedGenerationKEK,
  randomBytes,
  importKey,
  deriveKey,
  sealV2,
  openV2,
  generationAAD,
  recoveryVerifier,
} = cryptoLib;
export async function restoreFixture(
  baseline = process.env.VAULT_RESTORE_WASM ??
    "target/vault-synthetic-funding-build/wasm32-unknown-unknown/release/vault_canister.wasm",
  { priorCanisters = 0, credits = 2_000_000_000_000n, testThresholdKeys = false } = {},
) {
  const server = await startVaultPocketIc(PocketIcServer.getBinPath());
  let pic;
  try {
    const options = {
      fiduciary: { state: { type: "new" } },
      icpConfig: { betaFeatures: "Enabled" },
    };
    pic = testThresholdKeys
      ? await createVaultPocketIcWithTestKeys(server.getUrl(), options)
      : await PocketIc.create(server.getUrl(), options);
    const wasm = resolve(
      root,
      "target/vault-synthetic-funding-build/wasm32-unknown-unknown/release/vault_canister.wasm",
    );
    for (let i = 0; i < priorCanisters; i++)
      await pic.createCanister({ sender: owner, cycles: 1_000_000_000_000n });
    const fixture = await pic.setupCanister({
      sender: owner,
      idlFactory: vaultIDL,
      wasm: resolve(root, baseline),
      arg: IDL.encode([], []),
      cycles: 100_000_000_000_000n,
    });
    const { actor, canisterId } = fixture;
    actor.setPrincipal(owner);
    ok(
      await actor.set_config([
        {
          origin: "https://vault.kinic.xyz",
          rp_id: "vault.kinic.xyz",
          key_name: "key_1",
          minimum_cycles: 100_000_000_000n,
        },
      ]),
    );
    const fake = await pic.setupCanister({
      sender: owner,
      idlFactory: () =>
        IDL.Service({ configure: IDL.Func([IDL.Nat8, IDL.Nat64], [], []) }),
      wasm: resolve(
        root,
        "target/wasm32-unknown-unknown/release/vault_ledger_fixture.wasm",
      ),
      arg: IDL.encode([], []),
      cycles: 10_000_000_000_000n,
    });
    fake.actor.setPrincipal(owner);
    await fake.actor.configure(0, 10n);
    ok(
      await actor.set_funding_config([
        {
          ledger: fake.canisterId,
          recipient: canisterId,
          cycles_per_kinic: credits,
        },
      ]),
    );
    const purchase = {
      operation: b(80),
      beneficiary: owner,
      amount_e8s: 100_000_000n,
      min_credits: credits,
      created_at_time: BigInt(await pic.getTime()) * 1_000_000n,
    };
    ok(await actor.quote_purchase(purchase));
    ok(await actor.pay_purchase(purchase.operation));
    const paid = ok(await actor.account_balance());
    const ephemeral = key(),
      credential = { ...key(), id: b(41) },
      lost = { ...key(), id: b(42) };
    const setup = ok(
      await actor.bootstrap({
        reserve: { vault: b(1), operation: b(2) },
        public_key: ephemeral.public,
      }),
    );
    const bootstrap = ok(
      await actor.register_bootstrap(
        b(2),
        registration(setup.challenge, credential),
      ),
    );
    const counters = new Map();
    async function send(grant, operation, { deferred = false } = {}) {
      const id = Buffer.from(grant.id).toString("hex"),
        counter = counters.get(id) ?? 0n;
      const payload = new Uint8Array(
        IDL.encode(
          [mutationType],
          [
            {
              version: 2,
              owner,
              canister: canisterId,
              grant: grant.id,
              counter,
              operation,
            },
          ],
        ),
      );
      const signature = sign(
        null,
        cat(Buffer.from("kinic-vault/mutation/v2\0"), payload),
        ephemeral.privateKey,
      );
      if (deferred) {
        const d = pic.createDeferredActor(vaultIDL, canisterId);
        d.setPrincipal(owner);
        const finish = await d.mutate(payload, signature);
        return {
          payload,
          signature,
          complete: async () => {
            const result = await finish();
            if ("Ok" in result) counters.set(id, counter + 1n);
            return { result, payload, signature };
          },
        };
      }
      const result = await actor.mutate(payload, signature);
      if ("Ok" in result) counters.set(id, counter + 1n);
      return { result, payload, signature };
    }
    const cryptoG = (g) => ({
      ...g,
      version: 2,
      canister: g.canister.toText(),
      owner: g.owner.toText(),
      vault: new Uint8Array(g.vault),
      nonce: new Uint8Array(g.nonce),
    });
    async function derive(grant, g, job, attempt, role) {
      const transport = TransportSecretKey.random();
      const op = job
        ? {
            IncidentDerive: {
              job,
              attempt,
              role,
              generation: g,
              transport: transport.publicKeyBytes(),
            },
          }
        : {
            Derive: {
              vault: g.vault,
              epoch: g.epoch,
              attempt: [b(2)],
              assertion: [],
              transport: transport.publicKeyBytes(),
            },
          };
      const handle = ok((await send(grant, op)).result).Handle;
      const key = ok((await send(grant, { KeyResult: { handle } })).result).Key;
      return verifiedGenerationKEK(
        new Uint8Array(key.encrypted_key),
        transport,
        cryptoG(g),
        true,
      );
    }
    const sourceG = setup.header.generation[0];
    const sourceKEK = await derive(bootstrap, sourceG);
    const sourceRaw = randomBytes(32),
      sourceSecret = randomBytes(32);
    const normal = await sealV2(
      sourceKEK,
      sourceRaw,
      generationAAD(cryptoG(sourceG), b(0), 0n, "normal"),
    );
    const recovery = await sealV2(
      await deriveKey(sourceSecret, "recovery"),
      sourceRaw,
      generationAAD(cryptoG(sourceG), b(0), 0n, "recovery"),
    );
    ok(
      (
        await send(bootstrap, {
          Activate: {
            request: {
              vault: b(1),
              attempt: [b(2)],
              operation: b(3),
              normal,
              recovery,
              registration: [],
              assertion: [],
            },
            recovery_verifier: await recoveryVerifier(sourceSecret),
          },
        })
      ).result,
    );

    const sourceRoot = await importKey(sourceRaw);
    const document = await encryptDocument(
      sourceRoot,
      b(1),
      b(20),
      1n,
      { kind: "note", title: "retained history" },
      new TextEncoder().encode("retained encrypted history"),
      cryptoG(sourceG),
    );
    const upload = ok(
      (
        await send(bootstrap, {
          BeginRevision: {
            vault: b(1),
            object: b(20),
            expected_revision: 0n,
            operation: b(21),
            plain_size: 26n,
            manifest: document.manifest,
            chunk_hashes: document.hashes,
          },
        })
      ).result,
    ).Upload;
    ok(
      (
        await send(bootstrap, {
          PutChunk: {
            vault: b(1),
            upload: upload.id,
            index: 0,
            data: document.chunks[0],
          },
        })
      ).result,
    );
    ok(
      (
        await send(bootstrap, {
          CommitRevision: { vault: b(1), upload: upload.id },
        })
      ).result,
    );
    ok(
      (
        await send(bootstrap, {
          DeleteObject: {
            vault: b(1),
            object: b(20),
            expected_revision: 1n,
            operation: b(22),
          },
        })
      ).result,
    );

    let operation = 50;
    async function fresh(
      purpose,
      generations = [sourceG],
      passkey = credential,
    ) {
      const request = {
        operation: b(operation++),
        public_key: ephemeral.public,
        credential: passkey.id,
        purpose,
        generations,
      };
      if (
        "RestorePrepare" in purpose ||
        "RestoreTarget" in purpose ||
        "RestoreCleanup" in purpose
      ) {
        const ch = ok(await actor.begin_restore_grant(request));
        return ok(
          await actor.finish_restore_grant(
            request.operation,
            assertion(ch, passkey),
            "RestoreCleanup" in purpose,
          ),
        );
      }
      const cleanup = "Cleanup" in purpose;
      const ch = ok(
        await (cleanup ? actor.begin_cleanup : actor.begin_grant)(request),
      );
      return ok(
        await (cleanup ? actor.finish_cleanup : actor.finish_grant)(
          request.operation,
          assertion(ch, passkey),
        ),
      );
    }

    return {
      pic,
      actor,
      canisterId,
      fake,
      wasm,
      sourceG,
      sourceRoot,
      sourceRaw,
      sourceSecret,
      credential,
      lost,
      ephemeral,
      bootstrap,
      send,
      fresh,
      derive,
      cryptoG,
      close: async () => {
        await pic.tearDown();
        await server.stop();
      },
    };
  } catch (error) {
    await pic?.tearDown();
    await server.stop();
    throw error;
  }
}
export {
  b,
  b64,
  hash,
  key,
  owner,
  other,
  ok,
  registration,
  assertion,
  IDL,
  Principal,
  cryptoLib,
  root,
};
