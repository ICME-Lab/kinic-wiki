import { documentAAD, type VaultContext } from "./context.ts";
import { strictJSON } from "./strict-json.ts";
import {
  importKey,
  open,
  seal,
  randomBytes,
  utf8,
  concat,
  type Envelope,
} from "./index.ts";
async function sealV3(
  key: CryptoKey,
  plain: Uint8Array,
  binding: Uint8Array,
): Promise<Envelope> {
  return { ...(await seal(key, plain, binding)), version: 3 };
}
async function openV3(key: CryptoKey, envelope: Envelope, binding: Uint8Array) {
  if (envelope.version !== 3) throw Error("InvalidEnvelope");
  return open(key, envelope, binding);
}
export const b64 = (b: Uint8Array) => {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};
export const unb64 = (s: string) => {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw Error("InvalidEncoding");
  const decoded = Uint8Array.from(
    atob(s.replaceAll("-", "+").replaceAll("_", "/")),
    (c) => c.charCodeAt(0),
  );
  if (b64(decoded) !== s) throw Error("InvalidEncoding");
  return decoded;
};
export const pack = (e: Envelope) => ({
  version: e.version,
  nonce: b64(e.nonce),
  ciphertext: b64(e.ciphertext),
});
export const unpack = (e: ReturnType<typeof pack>): Envelope => ({
  version: e.version,
  nonce: unb64(e.nonce),
  ciphertext: unb64(e.ciphertext),
});
export const hash = async (b: Uint8Array) =>
  new Uint8Array(
    await crypto.subtle.digest("SHA-256", new Uint8Array(b).buffer),
  );
export type Metadata = {
  kind: "note" | "credential" | "attachment";
  title: string;
  filename?: string;
  mime?: string;
};
export type Manifest = {
  version: 3;
  dek: ReturnType<typeof pack>;
  metadata: ReturnType<typeof pack>;
  nonces: string[];
};
export async function encryptDocumentV3(
  root: CryptoKey,
  context: VaultContext,
  object: Uint8Array,
  revision: bigint,
  metadata: Metadata,
  plaintext: Uint8Array,
) {
  if (
    plaintext.length > 10 * 1024 * 1024 ||
    (metadata.kind !== "attachment" && plaintext.length > 256 * 1024) ||
    metadata.title.length > 512
  )
    throw Error("SizeLimit");
  const raw = randomBytes(32);
  const key = await importKey(raw);
  const dek = await sealV3(
    root,
    raw,
    documentAAD(context, object, revision, "dek"),
  );
  raw.fill(0);
  const meta = utf8.encode(JSON.stringify(metadata));
  if (meta.length > 8192) throw Error("SizeLimit");
  const encryptedMetadata = await sealV3(
    key,
    meta,
    documentAAD(context, object, revision, "metadata"),
  );
  const chunks: Uint8Array[] = [],
    nonces: string[] = [];
  for (let i = 0; i < Math.max(1, Math.ceil(plaintext.length / 1048576)); i++) {
    const e = await sealV3(
      key,
      plaintext.subarray(i * 1048576, (i + 1) * 1048576),
      documentAAD(context, object, revision, "chunk", i),
    );
    chunks.push(e.ciphertext);
    nonces.push(b64(e.nonce));
  }
  const manifest = utf8.encode(
    JSON.stringify({
      version: 3,
      dek: pack(dek),
      metadata: pack(encryptedMetadata),
      nonces,
    } satisfies Manifest),
  );
  return { manifest, chunks, hashes: await Promise.all(chunks.map(hash)) };
}
export async function readManifestV3(
  root: CryptoKey,
  context: VaultContext,
  object: Uint8Array,
  revision: bigint,
  bytes: Uint8Array,
) {
  if (bytes.length > 65536) throw Error("InvalidManifest");
  const m = strictJSON(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  ) as Manifest;
  if (
    m.version !== 3 ||
    !Array.isArray(m.nonces) ||
    m.nonces.length < 1 ||
    m.nonces.length > 10
  )
    throw Error("InvalidManifest");
  const raw = await openV3(
    root,
    unpack(m.dek),
    documentAAD(context, object, revision, "dek"),
  );
  const key = await importKey(raw);
  raw.fill(0);
  const metadata: Metadata = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(
      await openV3(
        key,
        unpack(m.metadata),
        documentAAD(context, object, revision, "metadata"),
      ),
    ),
  );
  if (
    !["note", "credential", "attachment"].includes(metadata.kind) ||
    typeof metadata.title !== "string"
  )
    throw Error("InvalidMetadata");
  return { manifest: m, key, metadata };
}
export async function decryptDocumentV3(
  root: CryptoKey,
  context: VaultContext,
  object: Uint8Array,
  revision: bigint,
  manifest: Uint8Array,
  chunks: Uint8Array[],
  hashes: Uint8Array[],
) {
  const parsed = await readManifestV3(
    root,
    context,
    object,
    revision,
    manifest,
  );
  if (
    chunks.length !== parsed.manifest.nonces.length ||
    hashes.length !== chunks.length
  )
    throw Error("MissingChunk");
  const plain: Uint8Array[] = [];
  for (let i = 0; i < chunks.length; i++) {
    if (b64(await hash(chunks[i])) !== b64(hashes[i]))
      throw Error("CorruptChunk");
    plain.push(
      await openV3(
        parsed.key,
        {
          version: 3,
          nonce: unb64(parsed.manifest.nonces[i]),
          ciphertext: chunks[i],
        },
        documentAAD(context, object, revision, "chunk", i),
      ),
    );
  }
  return { metadata: parsed.metadata, plaintext: concat(...plain) };
}

export {
  encryptDocumentV3 as encryptDocument,
  readManifestV3 as readManifest,
  decryptDocumentV3 as decryptDocument,
};
