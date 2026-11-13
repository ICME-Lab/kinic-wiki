/** Bounded ciphertext transport and local full verification before a signed acknowledgment. */
import type {
  VaultActor,
  IncidentStatus,
  IncidentTarget,
  Revision,
  Export,
  IncidentRead,
} from "./contracts";
import type { SignedMutations } from "./signed";
import type { Session } from "./session";
import { bytes, ok } from "./wire";
import { cryptoGeneration, verifyIncidentKit } from "./incident";
import {
  b64,
  unb64,
  hash,
  pack,
  rewrapManifest,
} from "../../vault-crypto/src/documents";
import {
  utf8,
  openV2,
  generationAAD,
  randomBytes,
} from "../../vault-crypto/src/index";
import { strictJSON } from "../../vault-crypto/src/strict-json";
import {
  makeArchive,
  openArchive,
  type PortableHeader,
  type PortableRecord,
} from "../../vault-backup/src/index";
export function portableRecord(r: Revision): PortableRecord {
  return {
    vault: b64(bytes(r.vault)),
    object: b64(bytes(r.object)),
    revision: String(r.revision),
    sequence: String(r.sequence),
    plain_size: String(r.plain_size),
    manifest: b64(bytes(r.manifest)),
    hashes: r.chunk_hashes.map((h) => b64(bytes(h))),
    deleted: r.deleted,
  };
}
export function portableExport(e: Export): PortableHeader {
  const h = e.header,
    g = h.generation[0];
  if (!g || !h.normal[0] || !h.recovery[0]) throw Error("MissingTargetHeader");
  return {
    version: 2,
    envelope_revision: "0",
    vault: b64(bytes(h.id)),
    epoch: String(g.epoch),
    sequence: String(e.sequence),
    key_name: g.key_name,
    generation: {
      ...cryptoGeneration(g),
      vault: b64(bytes(g.vault)),
      nonce: b64(bytes(g.nonce)),
      epoch: String(g.epoch),
    },
    recovery_verifier: b64(bytes(h.recovery_verifier)),
    record_count: Number(e.record_count),
    chunk_count: Number(e.chunk_count),
    plain_bytes: String(e.plain_bytes),
    normal: pack({
      ...h.normal[0],
      nonce: bytes(h.normal[0].nonce),
      ciphertext: bytes(h.normal[0].ciphertext),
    }),
    recovery: pack({
      ...h.recovery[0],
      nonce: bytes(h.recovery[0].nonce),
      ciphertext: bytes(h.recovery[0].ciphertext),
    }),
  };
}
export async function wrapNext(
  actor: VaultActor,
  signer: SignedMutations,
  session: Session,
  j: IncidentStatus,
  t: IncidentTarget,
  roots: { source: CryptoKey; target: CryptoKey },
) {
  const ticket = session.capture(),
    after = t.coverage[0]?.cursor ?? 0n;
  if (t.coverage[0]?.complete) return;
  const page = ok(
    await actor.incident_source_index(j.job, t.source.id, t.attempt, after),
  );
  session.check(ticket);
  const rows = [];
  for (const r of page.entries) {
    let wrapper = new Uint8Array();
    if (!r.deleted) {
      const manifest = await rewrapManifest(
        roots.source,
        roots.target,
        bytes(r.vault),
        bytes(r.object),
        r.revision,
        bytes(r.manifest),
        cryptoGeneration(t.target[0]!),
        cryptoGeneration(t.source.generation[0]!),
      );
      session.check(ticket);
      wrapper = utf8.encode(
        JSON.stringify(
          (strictJSON(new TextDecoder().decode(manifest)) as { dek: unknown })
            .dek,
        ),
      );
    }
    rows.push({
      object: r.object,
      revision: r.revision,
      sequence: r.sequence,
      source_digest: await hash(bytes(r.manifest)),
      wrapper,
    });
    session.check(ticket);
  }
  return signer.send({
    IncidentWrap: { vault: t.source.id, attempt: t.attempt, after, rows },
  });
}
export async function saveAndVerify(
  actor: VaultActor,
  signer: SignedMutations,
  session: Session,
  j: IncidentStatus,
  t: IncidentTarget,
  kek: CryptoKey,
  save: (file: Uint8Array) => Promise<void>,
  reselectArchive: () => Promise<Uint8Array>,
  reselectKit: () => Promise<Uint8Array>,
) {
  const ticket = session.capture();
  const existing = t.staged_export[0]?.export;
  const exportId =
    existing && existing.expires > BigInt(Math.floor(Date.now() / 1000))
      ? existing.id
      : randomBytes(16);
  await signer.send({
    IncidentPrepareExport: {
      vault: t.source.id,
      attempt: t.attempt,
      export: exportId,
    },
  });
  session.check(ticket);
  const prepared = ok(await actor.incident_status())[0];
  session.check(ticket);
  const staged = prepared?.targets.find(
    (x) =>
      b64(bytes(x.source.id)) === b64(bytes(t.source.id)) &&
      b64(bytes(x.attempt)) === b64(bytes(t.attempt)),
  )?.staged_export[0];
  if (
    !prepared ||
    b64(bytes(prepared.job)) !== b64(bytes(j.job)) ||
    !staged ||
    b64(bytes(staged.export.id)) !== b64(bytes(exportId))
  )
    throw Error("TargetChanged");
  const request: IncidentRead = {
    descriptor_digest: staged.descriptor_digest,
    job: j.job,
    vault: t.source.id,
    attempt: t.attempt,
    export: exportId,
  };
  const descriptor = ok(await actor.incident_staged_export(request));
  session.check(ticket);
  const header = portableExport(descriptor.export),
    records: PortableRecord[] = [];
  let after = 0n;
  for (;;) {
    const p = ok(await actor.incident_staged_index(request, after));
    session.check(ticket);
    records.push(...p.entries.map(portableRecord));
    if (records.length > 10000) throw Error("SizeLimit");
    if (!p.next[0]) break;
    if (p.next[0] <= after) throw Error("InvalidCursor");
    after = p.next[0];
  }
  let raw: Uint8Array | undefined,
    kit: Uint8Array | undefined,
    secret: Uint8Array | undefined,
    selected: Uint8Array | undefined,
    verifiedRaw: Uint8Array | undefined;
  const detach = session.addLockCleanup(() => {
    raw?.fill(0);
    kit?.fill(0);
    secret?.fill(0);
    verifiedRaw?.fill(0);
  });
  try {
    const normal = t.normal[0]!;
    raw = await openV2(
      kek,
      {
        ...normal,
        nonce: bytes(normal.nonce),
        ciphertext: bytes(normal.ciphertext),
      },
      generationAAD(
        cryptoGeneration(t.target[0]!),
        new Uint8Array(16),
        0n,
        "normal",
      ),
    );
    session.check(ticket);
    const archive = await makeArchive(
      header,
      records,
      async (r, i) => {
        const chunk = bytes(
          ok(
            await actor.incident_staged_chunk(
              request,
              unb64(r.object),
              BigInt(r.revision),
              i,
            ),
          ),
        );
        session.check(ticket);
        return chunk;
      },
      raw,
    );
    session.check(ticket);
    await save(archive);
    session.check(ticket);
    kit = await reselectKit();
    session.check(ticket);
    verifiedRaw = await verifyIncidentKit(t, kek, kit);
    session.check(ticket);
    if (b64(raw) !== b64(verifiedRaw)) throw Error("RootMismatch");
    secret = unb64(
      (strictJSON(new TextDecoder().decode(kit)) as { secret: string }).secret,
    );
    selected = await reselectArchive();
    session.check(ticket);
    const opened = await openArchive(selected, secret);
    try {
      session.check(ticket);
      if (
        JSON.stringify(opened.header) !== JSON.stringify(header) ||
        b64(opened.restoreRoot) !== b64(bytes(descriptor.commitment)) ||
        b64(opened.rootRaw) !== b64(raw)
      )
        throw Error("BackupMismatch");
      // Hash the reselected file; save completion alone is never acknowledgment authority.
      const archive_hash = await hash(selected);
      session.check(ticket);
      return await signer.send({
        IncidentConfirmBackup: {
          vault: t.source.id,
          attempt: t.attempt,
          ack: {
            descriptor_digest: descriptor.descriptor_digest,
            commitment: descriptor.commitment,
            archive_hash,
            archive_length: BigInt(selected.length),
            recovery_verifier: t.recovery_verifier,
            sequence: descriptor.export.sequence,
          },
        },
      });
    } finally {
      opened.rootRaw.fill(0);
    }
  } finally {
    detach();
    raw?.fill(0);
    kit?.fill(0);
    secret?.fill(0);
    verifiedRaw?.fill(0);
  }
}
