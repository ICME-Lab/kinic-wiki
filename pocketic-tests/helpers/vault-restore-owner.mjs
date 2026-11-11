// Build real three-Vault/ten-passkey owner states through signed production APIs.
import {
  b,
  key,
  ok,
  registration,
  cryptoLib,
} from "./vault-restore-fixture.mjs";
import { encryptDocument } from "../../packages/vault-crypto/src/documents.ts";
export async function addVault(f, id) {
  await f.pic.advanceTime(421_000);
  const vault = b(id),
    attempt = b(id + 10);
  const creation = await f.fresh({ Create: null }, []);
  const handle = ok(
    (await f.send(creation, { Create: { vault, operation: attempt } })).result,
  ).Handle;
  const header = ok(
    (await f.send(creation, { KeyResult: { handle } })).result,
  ).Header;
  const sourceG = header.generation[0];
  const normalGrant = await f.fresh({ Normal: null }, [sourceG]);
  const transport = cryptoLib.TransportSecretKey.random();
  const deriveHandle = ok(
    (
      await f.send(normalGrant, {
        Derive: {
          vault,
          epoch: sourceG.epoch,
          attempt: [attempt],
          assertion: [],
          transport: transport.publicKeyBytes(),
        },
      })
    ).result,
  ).Handle;
  const reply = ok(
    (await f.send(normalGrant, { KeyResult: { handle: deriveHandle } })).result,
  ).Key;
  const kek = await cryptoLib.verifiedGenerationKEK(
    new Uint8Array(reply.encrypted_key),
    transport,
    f.cryptoG(sourceG),
    true,
  );
  const sourceRaw = cryptoLib.randomBytes(32),
    sourceSecret = cryptoLib.randomBytes(32),
    sourceRoot = await cryptoLib.importKey(sourceRaw);
  const normal = await cryptoLib.sealV2(
    kek,
    sourceRaw,
    cryptoLib.generationAAD(f.cryptoG(sourceG), b(0), 0n, "normal"),
  );
  const recovery = await cryptoLib.sealV2(
    await cryptoLib.deriveKey(sourceSecret, "recovery"),
    sourceRaw,
    cryptoLib.generationAAD(f.cryptoG(sourceG), b(0), 0n, "recovery"),
  );
  ok(
    (
      await f.send(normalGrant, {
        Activate: {
          request: {
            vault,
            attempt: [attempt],
            operation: b(id + 20),
            normal,
            recovery,
            registration: [],
            assertion: [],
          },
          recovery_verifier: await cryptoLib.recoveryVerifier(sourceSecret),
        },
      })
    ).result,
  );
  const d = await encryptDocument(
    sourceRoot,
    vault,
    b(20),
    1n,
    { kind: "note", title: "retained history" },
    new TextEncoder().encode("retained encrypted history"),
    f.cryptoG(sourceG),
  );
  const upload = ok(
    (
      await f.send(normalGrant, {
        BeginRevision: {
          vault,
          object: b(20),
          expected_revision: 0n,
          operation: b(id + 30),
          plain_size: 26n,
          manifest: d.manifest,
          chunk_hashes: d.hashes,
        },
      })
    ).result,
  ).Upload;
  ok(
    (
      await f.send(normalGrant, {
        PutChunk: { vault, upload: upload.id, index: 0, data: d.chunks[0] },
      })
    ).result,
  );
  ok(
    (
      await f.send(normalGrant, {
        CommitRevision: { vault, upload: upload.id },
      })
    ).result,
  );
  ok(
    (
      await f.send(normalGrant, {
        DeleteObject: {
          vault,
          object: b(20),
          expected_revision: 1n,
          operation: b(id + 40),
        },
      })
    ).result,
  );
  return { ...f, sourceG, sourceRaw, sourceSecret, sourceRoot };
}
export async function fillCredentials(f) {
  await f.pic.advanceTime(421_000);
  const grant = await f.fresh({ Credentials: null });
  const keys = [];
  for (let id = 141; id <= 149; id++) {
    const credential = { ...key(), id: b(id) };
    const scope = { Global: null };
    const ch = ok(
      (
        await f.send(grant, {
          BeginRegistration: { vault: f.sourceG.vault, scope },
        })
      ).result,
    ).Challenge;
    ok(
      (
        await f.send(grant, {
          RegisterCredential: {
            vault: f.sourceG.vault,
            scope,
            registration: registration(ch, credential),
          },
        })
      ).result,
    );
    keys.push(credential);
  }
  return keys;
}
export async function startParent(f, sources, lost) {
  const context = ok(await f.actor.incident_context())[0];
  const selected = context.credentials.find((c) =>
    Buffer.from(c.credential).equals(lost.id),
  );
  const preparation = {
    job: b(70),
    namespace: context.namespace,
    compromised: [{ credential: lost.id, version: selected.version }],
    sources,
    targets: sources.map((g, i) => ({
      namespace: context.namespace,
      vault: g.vault,
      attempt: b(71 + i),
    })),
  };
  const grant = await f.fresh({ IncidentPrepare: preparation }, sources);
  ok((await f.send(grant, { IncidentStart: null })).result);
  return ok(await f.actor.incident_status())[0];
}
