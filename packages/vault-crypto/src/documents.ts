import {
  aad,
  importKey,
  open,
  seal,
  randomBytes,
  utf8,
  concat,
  type Envelope,
} from "./index.ts";
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
  version: 1;
  dek: ReturnType<typeof pack>;
  metadata: ReturnType<typeof pack>;
  nonces: string[];
};
export async function encryptDocument(
  root: CryptoKey,
  vault: Uint8Array,
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
  const dek = await seal(root, raw, aad(vault, object, revision, "dek"));
  raw.fill(0);
  const meta = utf8.encode(JSON.stringify(metadata));
  if (meta.length > 8192) throw Error("SizeLimit");
  const encryptedMetadata = await seal(
    key,
    meta,
    aad(vault, object, revision, "metadata"),
  );
  const chunks: Uint8Array[] = [],
    nonces: string[] = [];
  for (let i = 0; i < Math.max(1, Math.ceil(plaintext.length / 1048576)); i++) {
    const e = await seal(
      key,
      plaintext.subarray(i * 1048576, (i + 1) * 1048576),
      aad(vault, object, revision, "chunk", i),
    );
    chunks.push(e.ciphertext);
    nonces.push(b64(e.nonce));
  }
  const manifest = utf8.encode(
    JSON.stringify({
      version: 1,
      dek: pack(dek),
      metadata: pack(encryptedMetadata),
      nonces,
    } satisfies Manifest),
  );
  return { manifest, chunks, hashes: await Promise.all(chunks.map(hash)) };
}
export async function readManifest(
  root: CryptoKey,
  vault: Uint8Array,
  object: Uint8Array,
  revision: bigint,
  bytes: Uint8Array,
) {
  if (bytes.length > 65536) throw Error("InvalidManifest");
  const m: Manifest = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );
  if (
    m.version !== 1 ||
    !Array.isArray(m.nonces) ||
    m.nonces.length < 1 ||
    m.nonces.length > 10
  )
    throw Error("InvalidManifest");
  const raw = await open(
    root,
    unpack(m.dek),
    aad(vault, object, revision, "dek"),
  );
  const key = await importKey(raw);
  raw.fill(0);
  const metadata: Metadata = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(
      await open(
        key,
        unpack(m.metadata),
        aad(vault, object, revision, "metadata"),
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
export async function decryptDocument(
  root: CryptoKey,
  vault: Uint8Array,
  object: Uint8Array,
  revision: bigint,
  manifest: Uint8Array,
  chunks: Uint8Array[],
  hashes: Uint8Array[],
) {
  const parsed = await readManifest(root, vault, object, revision, manifest);
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
      await open(
        parsed.key,
        {
          version: 1,
          nonce: unb64(parsed.manifest.nonces[i]),
          ciphertext: chunks[i],
        },
        aad(vault, object, revision, "chunk", i),
      ),
    );
  }
  return { metadata: parsed.metadata, plaintext: concat(...plain) };
}
