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
const CHUNK_SIZE = 1048576;
const MAX_METADATA = 8192;
function validMetadata(value: unknown): value is Metadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const m = value as Metadata;
  return (
    ["note", "credential", "attachment"].includes(m.kind) &&
    typeof m.title === "string" &&
    m.title.length <= 512 &&
    (m.filename === undefined || typeof m.filename === "string") &&
    (m.mime === undefined || typeof m.mime === "string")
  );
}
function validLength(metadata: Metadata, length: number) {
  return (
    Number.isSafeInteger(length) &&
    length >= 0 &&
    length <= (metadata.kind === "attachment" ? 10 * CHUNK_SIZE : 256 * 1024)
  );
}
const chunkCount = (length: number) =>
  Math.max(1, Math.ceil(length / CHUNK_SIZE));
type MetadataPayload = {
  metadata: Metadata;
  plaintext_length: number;
  chunk_count: number;
};
export async function encryptDocumentV3(
  root: CryptoKey,
  context: VaultContext,
  object: Uint8Array,
  revision: bigint,
  metadata: Metadata,
  plaintext: Uint8Array,
) {
  if (!validMetadata(metadata) || !validLength(metadata, plaintext.length))
    throw Error("SizeLimit");
  const count = chunkCount(plaintext.length);
  const meta = utf8.encode(
    JSON.stringify({
      metadata,
      plaintext_length: plaintext.length,
      chunk_count: count,
    } satisfies MetadataPayload),
  );
  const raw = randomBytes(32);
  try {
    if (meta.length > MAX_METADATA) throw Error("SizeLimit");
    const key = await importKey(raw);
    const dek = await seal(
      root,
      raw,
      documentAAD(context, object, revision, "dek"),
    );
    const encryptedMetadata = await seal(
      key,
      meta,
      documentAAD(context, object, revision, "metadata"),
    );
    const chunks: Uint8Array[] = [],
      nonces: string[] = [];
    for (let i = 0; i < count; i++) {
      const e = await seal(
        key,
        plaintext.subarray(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE),
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
  } finally {
    raw.fill(0);
    meta.fill(0);
  }
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
    !m ||
    m.version !== 3 ||
    !Array.isArray(m.nonces) ||
    m.nonces.length < 1 ||
    m.nonces.length > 10 ||
    m.nonces.some((n) => typeof n !== "string" || unb64(n).length !== 12)
  )
    throw Error("InvalidManifest");
  const raw = await open(
    root,
    unpack(m.dek),
    documentAAD(context, object, revision, "dek"),
  );
  let key: CryptoKey;
  try {
    key = await importKey(raw);
  } finally {
    raw.fill(0);
  }
  const meta = await open(
    key,
    unpack(m.metadata),
    documentAAD(context, object, revision, "metadata"),
  );
  try {
    if (meta.length > MAX_METADATA) throw Error("InvalidMetadata");
    const payload = strictJSON(
      new TextDecoder("utf-8", { fatal: true }).decode(meta),
    ) as MetadataPayload;
    if (
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      Object.keys(payload).length !== 3 ||
      !validMetadata(payload.metadata) ||
      !validLength(payload.metadata, payload.plaintext_length) ||
      payload.chunk_count !== chunkCount(payload.plaintext_length) ||
      payload.chunk_count !== m.nonces.length
    )
      throw Error("InvalidMetadata");
    return {
      manifest: m,
      key,
      metadata: payload.metadata,
      plaintext_length: payload.plaintext_length,
      chunk_count: payload.chunk_count,
    };
  } finally {
    meta.fill(0);
  }
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
    chunks.length !== parsed.chunk_count ||
    hashes.length !== parsed.chunk_count
  )
    throw Error("MissingChunk");
  const plain: Uint8Array[] = [];
  try {
    for (let i = 0; i < chunks.length; i++) {
      if (b64(await hash(chunks[i])) !== b64(hashes[i]))
        throw Error("CorruptChunk");
      plain.push(
        await open(
          parsed.key,
          {
            version: 3,
            nonce: unb64(parsed.manifest.nonces[i]),
            ciphertext: chunks[i],
          },
          documentAAD(context, object, revision, "chunk", i),
        ),
      );
      const expected =
        i < chunks.length - 1
          ? CHUNK_SIZE
          : parsed.plaintext_length - i * CHUNK_SIZE;
      if (plain[i].length !== expected) throw Error("InvalidExtent");
    }
    const plaintext = concat(...plain);
    return { metadata: parsed.metadata, plaintext };
  } finally {
    plain.forEach((p) => p.fill(0));
  }
}
