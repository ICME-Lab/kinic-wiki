import {
  generationBytes,
  generationAAD,
  openV2,
  type Generation,
  type PortableGeneration,
} from "../../vault-crypto/src/generation.ts";
import { recoveryVerifier } from "../../vault-crypto/src/recovery.ts";
import { strictJSON } from "../../vault-crypto/src/strict-json.ts";
import {
  aad,
  concat,
  deriveKey,
  importKey,
  open,
  seal,
  u64,
  utf8,
  type Envelope,
} from "../../vault-crypto/src/index.ts";
import {
  b64,
  unb64,
  pack,
  unpack,
  hash,
  decryptDocument,
} from "../../vault-crypto/src/documents.ts";
export type PortableHeader = {
  version: 1 | 2;
  generation?: PortableGeneration;
  recovery_verifier?: string;
  vault: string;
  epoch: string;
  sequence: string;
  key_name: string;
  record_count: number;
  chunk_count: number;
  plain_bytes: string;
  normal: ReturnType<typeof pack>;
  recovery: ReturnType<typeof pack>;
};
export type PortableRecord = {
  vault: string;
  object: string;
  revision: string;
  sequence: string;
  plain_size: string;
  manifest: string;
  hashes: string[];
  deleted: boolean;
};
const MAGIC = utf8.encode("KVLT0001");
const MAGIC_V2 = utf8.encode("KVLT0002");
export function headerGeneration(h: PortableHeader): Generation | undefined {
  if (h.version === 1) return undefined;
  const g = h.generation;
  if (!g) throw Error("InvalidGeneration");
  const result = {
    ...g,
    vault: unb64(g.vault),
    nonce: unb64(g.nonce),
    epoch: decimal(g.epoch),
  };
  generationBytes(result);
  return result;
}
const ZERO = new Uint8Array(16);
const MAX = 256 * 1024 * 1024;
const json = (x: unknown) => utf8.encode(JSON.stringify(x));
const eq = (a: Uint8Array, b: Uint8Array) => b64(a) === b64(b);
const word = (n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  return b;
};
const frame = (b: Uint8Array) => concat(word(b.length), b);
export function restoreLeaf(r: PortableRecord) {
  const manifest = unb64(r.manifest);
  return hash(
    concat(
      utf8.encode("kinic-vault/restore-record/v1"),
      unb64(r.vault),
      unb64(r.object),
      u64(BigInt(r.revision)),
      u64(BigInt(r.sequence)),
      u64(BigInt(r.plain_size)),
      new Uint8Array([Number(r.deleted)]),
      word(manifest.length),
      manifest,
      word(r.hashes.length),
      ...r.hashes.map(unb64),
    ),
  );
}
export async function restoreRoot(records: PortableRecord[]) {
  let root = new Uint8Array(32);
  for (const r of records)
    root = new Uint8Array(await hash(concat(root, await restoreLeaf(r))));
  return root;
}
/** V2 target commitment, including an empty or tombstone-only archive. V1 source stays zero-seeded. */
export async function targetRestoreRoot(
  generation: Generation,
  records: PortableRecord[],
) {
  let root = new Uint8Array(
    await hash(
      concat(
        utf8.encode("kinic-vault/restore-root/v2\0"),
        generationBytes(generation),
      ),
    ),
  );
  for (const record of records)
    root = new Uint8Array(await hash(concat(root, await restoreLeaf(record))));
  return root;
}
function decimal(s: string, max = 9223372036854775807n) {
  if (typeof s !== "string" || !/^(0|[1-9][0-9]*)$/.test(s))
    throw Error("InvalidBackup");
  const n = BigInt(s);
  if (n > max) throw Error("InvalidBackup");
  return n;
}
function validateHeader(h: PortableHeader) {
  if (
    ![1, 2].includes(h.version) ||
    unb64(h.vault).length !== 16 ||
    decimal(h.epoch) < 0 ||
    decimal(h.sequence) < 0
  )
    throw Error("InvalidBackup");
  if (h.version === 2) {
    const g = headerGeneration(h)!;
    if (
      b64(g.vault) !== h.vault ||
      g.epoch !== BigInt(h.epoch) ||
      g.key_name !== h.key_name ||
      !h.recovery_verifier ||
      unb64(h.recovery_verifier).length !== 32
    )
      throw Error("InvalidBackup");
  }
  u64(BigInt(h.epoch));
  u64(BigInt(h.sequence));
  for (const e of [h.normal, h.recovery]) {
    const env = unpack(e);
    if (
      env.version !== h.version ||
      env.nonce.length !== 12 ||
      env.ciphertext.length !== 48
    )
      throw Error("InvalidBackup");
  }
}
function validateRecords(h: PortableHeader, records: PortableRecord[]) {
  if (
    !Number.isSafeInteger(h.record_count) ||
    h.record_count < 0 ||
    h.record_count > 10000 ||
    h.record_count !== records.length ||
    !Number.isSafeInteger(h.chunk_count) ||
    h.chunk_count !== records.reduce((n, r) => n + r.hashes.length, 0) ||
    decimal(h.plain_bytes) !==
      records.reduce((n, r) => n + BigInt(r.plain_size), 0n)
  )
    throw Error("IncompleteBackup");
  let sequence = 0n;
  const ids = new Set<string>();
  const counts = new Map<string, number>();
  const heads = new Map<string, bigint>();
  for (const r of records) {
    if (
      r.vault !== h.vault ||
      unb64(r.object).length !== 16 ||
      decimal(r.revision) < 1n ||
      decimal(r.revision) <= (heads.get(r.object) ?? 0n) ||
      decimal(r.sequence) <= sequence ||
      BigInt(r.sequence) > BigInt(h.sequence) ||
      decimal(r.plain_size) < 0n ||
      BigInt(r.plain_size) > 10485760n ||
      unb64(r.manifest).length > 65536 ||
      r.hashes.some((x) => unb64(x).length !== 32)
    )
      throw Error("InvalidBackup");
    const k = `${r.object}/${r.revision}`;
    if (ids.has(k)) throw Error("DuplicateRecord");
    ids.add(k);
    heads.set(r.object, BigInt(r.revision));
    sequence = BigInt(r.sequence);
    const n = (counts.get(r.object) ?? 0) + 1;
    if (n > 10) throw Error("InvalidBackup");
    counts.set(r.object, n);
    if (r.deleted) {
      if (BigInt(r.plain_size) !== 0n || r.hashes.length || r.manifest !== "")
        throw Error("InvalidBackup");
    } else if (
      r.hashes.length !== Math.max(1, Math.ceil(Number(r.plain_size) / 1048576))
    )
      throw Error("InvalidBackup");
  }
}
export async function makeArchive(
  header: PortableHeader,
  records: PortableRecord[],
  getChunk: (r: PortableRecord, i: number) => Promise<Uint8Array>,
  rootRaw: Uint8Array,
) {
  validateHeader(header);
  if (records.length > 10000) throw Error("SizeLimit");
  validateRecords(header, records);
  const parts: Uint8Array[] = [
    header.version === 2 ? MAGIC_V2 : MAGIC,
    frame(json({ header, count: records.length })),
  ];
  let total = parts.reduce((n, p) => n + p.length, 0);
  for (const r of records) {
    const meta = frame(json(r));
    parts.push(meta);
    total += meta.length;
    for (let i = 0; i < r.hashes.length; i++) {
      const chunk = await getChunk(r, i);
      if (chunk.length > 1048592 || b64(await hash(chunk)) !== r.hashes[i])
        throw Error("CorruptChunk");
      const p = frame(chunk);
      total += p.length;
      if (total > MAX - 65536) throw Error("SizeLimit");
      parts.push(p);
    }
  }
  const prefix = concat(...parts);
  const key = await deriveKey(rootRaw, "archive");
  const proof = await seal(
    key,
    json({
      hash: b64(await hash(prefix)),
      count: records.length,
      bytes: prefix.length,
    }),
    aad(unb64(header.vault), ZERO, BigInt(header.sequence), "archive"),
  );
  return concat(prefix, word(0), frame(json(pack(proof))));
}
export async function openArchive(
  data: Uint8Array,
  recoverySecret: Uint8Array,
) {
  if (
    data.length > MAX ||
    (!eq(data.subarray(0, 8), MAGIC) && !eq(data.subarray(0, 8), MAGIC_V2))
  )
    throw Error("InvalidBackup");
  let offset = 8;
  const take = (max: number) => {
    if (offset + 4 > data.length) throw Error("TruncatedBackup");
    const n = new DataView(data.buffer, data.byteOffset + offset, 4).getUint32(
      0,
    );
    offset += 4;
    if (n > max || offset + n > data.length) throw Error("InvalidBackup");
    const out = data.subarray(offset, offset + n);
    offset += n;
    return out;
  };
  const parse = <T>(b: Uint8Array): T =>
    strictJSON(new TextDecoder("utf-8", { fatal: true }).decode(b)) as T;
  const start = parse<{ header: PortableHeader; count: number }>(take(65536));
  const { header, count } = start;
  validateHeader(header);
  if (!eq(data.subarray(0, 8), header.version === 2 ? MAGIC_V2 : MAGIC))
    throw Error("InvalidBackup");
  if (!Number.isSafeInteger(count) || count < 0 || count > 10000)
    throw Error("InvalidBackup");
  const generation = headerGeneration(header);
  const recovered = generation
    ? await openV2(
        await deriveKey(recoverySecret, "recovery"),
        unpack(header.recovery),
        generationAAD(generation, ZERO, generation.epoch, "recovery"),
      )
    : await open(
        await deriveKey(recoverySecret, "recovery"),
        unpack(header.recovery),
        aad(unb64(header.vault), ZERO, BigInt(header.epoch), "recovery"),
      );
  if (
    generation &&
    b64(await recoveryVerifier(recoverySecret)) !== header.recovery_verifier
  ) {
    recovered.fill(0);
    throw Error("InvalidRecoveryVerifier");
  }
  const root = await importKey(recovered);
  const records: PortableRecord[] = [],
    chunks: Uint8Array[][] = [];
  try {
    for (let n = 0; n < count; n++) {
      const r = parse<PortableRecord>(take(100000));
      if (!Array.isArray(r.hashes) || r.hashes.length > 10)
        throw Error("InvalidBackup");
      records.push(r);
      const cs: Uint8Array[] = [];
      for (let i = 0; i < r.hashes.length; i++) {
        const c = take(1048592);
        if (b64(await hash(c)) !== r.hashes[i]) throw Error("CorruptChunk");
        cs.push(c);
      }
      chunks.push(cs);
    }
    validateRecords(header, records);
    const prefixEnd = offset;
    if (take(0).length !== 0) throw Error("InvalidBackup");
    const proof = unpack(parse<ReturnType<typeof pack>>(take(65536)));
    if (offset !== data.length) throw Error("TrailingData");
    const verified = parse<{ hash: string; count: number; bytes: number }>(
      await open(
        await deriveKey(recovered, "archive"),
        proof,
        aad(unb64(header.vault), ZERO, BigInt(header.sequence), "archive"),
      ),
    );
    if (
      verified.hash !== b64(await hash(data.subarray(0, prefixEnd))) ||
      verified.count !== count ||
      verified.bytes !== prefixEnd
    )
      throw Error("InvalidBackup");
    // Validate every AEAD before returning an archive as restorable, including metadata and DEK wraps.
    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      if (!r.deleted) {
        const d = await decryptDocument(
          root,
          unb64(r.vault),
          unb64(r.object),
          BigInt(r.revision),
          unb64(r.manifest),
          chunks[i],
          r.hashes.map(unb64),
          generation,
        );
        if (BigInt(d.plaintext.length) !== BigInt(r.plain_size))
          throw Error("InvalidBackup");
        d.plaintext.fill(0);
      }
    }
    return {
      header,
      records,
      chunks,
      root,
      rootRaw: recovered,
      restoreRoot:
        header.version === 2
          ? await targetRestoreRoot(headerGeneration(header)!, records)
          : await restoreRoot(records),
    };
  } catch (e) {
    recovered.fill(0);
    throw e;
  }
}

/** Full source verification precedes any target data. Source envelopes are never activation material. */
export async function transformArchive(
  data: Uint8Array,
  sourceSecret: Uint8Array,
  target: Generation,
  targetKEK: CryptoKey,
) {
  const source = await openArchive(data, sourceSecret);
  const { randomBytes, sealV2 } =
    await import("../../vault-crypto/src/index.ts");
  const { rewrapManifest } =
    await import("../../vault-crypto/src/documents.ts");
  const rootRaw = randomBytes(32),
    recoverySecret = randomBytes(32);
  try {
    if (
      b64(target.vault) !== source.header.vault ||
      target.epoch !== BigInt(source.header.epoch) + 1n ||
      target.epoch > 9223372036854775807n
    )
      throw Error("InvalidTarget");
    const old = headerGeneration(source.header);
    if (old && b64(old.nonce) === b64(target.nonce))
      throw Error("InvalidTarget");
    const root = await importKey(rootRaw),
      records: PortableRecord[] = [];
    for (const r of source.records) {
      records.push(
        r.deleted
          ? { ...r }
          : {
              ...r,
              manifest: b64(
                await rewrapManifest(
                  source.root,
                  root,
                  unb64(r.vault),
                  unb64(r.object),
                  BigInt(r.revision),
                  unb64(r.manifest),
                  target,
                  old,
                ),
              ),
            },
      );
    }
    const normal = await sealV2(
      targetKEK,
      rootRaw,
      generationAAD(target, ZERO, target.epoch, "normal"),
    );
    const recovery = await sealV2(
      await deriveKey(recoverySecret, "recovery"),
      rootRaw,
      generationAAD(target, ZERO, target.epoch, "recovery"),
    );
    const header: PortableHeader = {
      ...source.header,
      version: 2,
      epoch: target.epoch.toString(),
      key_name: target.key_name,
      generation: {
        ...target,
        vault: b64(target.vault),
        nonce: b64(target.nonce),
        epoch: target.epoch.toString(),
      },
      normal: pack(normal),
      recovery: pack(recovery),
      recovery_verifier: b64(await recoveryVerifier(recoverySecret)),
    };
    const archive = await makeArchive(
      header,
      records,
      async (r, i) => source.chunks[records.indexOf(r)][i],
      rootRaw,
    );
    const verified = await openArchive(archive, recoverySecret);
    verified.rootRaw.fill(0);
    return {
      header,
      records,
      chunks: source.chunks,
      archive,
      recoverySecret,
      rootRaw,
      root,
      sourceRestoreRoot: source.restoreRoot,
      targetRestoreRoot: await targetRestoreRoot(target, records),
    };
  } catch (error) {
    rootRaw.fill(0);
    recoverySecret.fill(0);
    throw error;
  } finally {
    source.rootRaw.fill(0);
  }
}
