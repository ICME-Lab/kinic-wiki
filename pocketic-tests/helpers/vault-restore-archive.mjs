// Independent valid legacy/current portable input, with preserved note+tombstone.
import { b, b64, owner, cryptoLib } from "./vault-restore-fixture.mjs";
import {
  pack,
  encryptDocument,
} from "../../packages/vault-crypto/src/documents.ts";
import { makeArchive } from "../../packages/vault-backup/src/index.ts";
import { offline } from "./vault-restore-pipeline.mjs";
export async function externalArchive(
  version,
  vault,
  title = "retained history",
) {
  const raw = cryptoLib.randomBytes(32),
    secret = cryptoLib.randomBytes(32),
    root = await cryptoLib.importKey(raw);
  const g =
    version === 2
      ? {
          version: 2,
          canister: "rrkah-fqaaa-aaaaa-aaaaq-cai",
          owner: owner.toText(),
          vault,
          epoch: 7n,
          nonce: cryptoLib.randomBytes(32),
          key_name: "key_1",
        }
      : undefined;
  const d = await encryptDocument(
    root,
    vault,
    b(20),
    1n,
    { kind: "note", title },
    new TextEncoder().encode("retained encrypted history"),
    g,
  );
  const envelope = async (purpose, k) =>
    version === 2
      ? cryptoLib.sealV2(k, raw, cryptoLib.generationAAD(g, b(0), 0n, purpose))
      : cryptoLib.seal(k, raw, cryptoLib.aad(vault, b(0), 0n, purpose));
  const header = {
    version,
    vault: b64(vault),
    epoch: version === 2 ? "7" : "0",
    sequence: "2",
    key_name: "key_1",
    record_count: 2,
    chunk_count: 1,
    plain_bytes: "26",
    normal: pack(await envelope("normal", root)),
    recovery: pack(
      await envelope("recovery", await cryptoLib.deriveKey(secret, "recovery")),
    ),
  };
  if (g)
    Object.assign(header, {
      envelope_revision: "0",
      generation: { ...g, vault: b64(vault), nonce: b64(g.nonce), epoch: "7" },
      recovery_verifier: b64(await cryptoLib.recoveryVerifier(secret)),
    });
  const records = [
    {
      vault: b64(vault),
      object: b64(b(20)),
      revision: "1",
      sequence: "1",
      plain_size: "26",
      manifest: b64(d.manifest),
      hashes: d.hashes.map(b64),
      deleted: false,
    },
    {
      vault: b64(vault),
      object: b64(b(20)),
      revision: "2",
      sequence: "2",
      plain_size: "0",
      manifest: "",
      hashes: [],
      deleted: true,
    },
  ];
  const archive = await makeArchive(
    header,
    records,
    async (_, i) => d.chunks[i],
    raw,
  );
  await offline(archive, secret);
  raw.fill(0);
  return { archive, secret };
}
