/** Same logical charge and temporary JSON accounting as vault_store::restore. */
import type {
  Revision,
  RestorePreflight,
  RestoreAdmissionStatus,
} from "./contracts";
import { bytes } from "./api";
import { b64, unb64 } from "../../vault-crypto/src/documents";
import type { PortableRecord } from "../../vault-backup/src/index";
export function restoreRevision(r: PortableRecord): Revision {
  return {
    vault: unb64(r.vault),
    object: unb64(r.object),
    revision: BigInt(r.revision),
    plain_size: BigInt(r.plain_size),
    manifest: unb64(r.manifest),
    chunk_hashes: r.hashes.map(unb64),
    deleted: r.deleted,
    sequence: BigInt(r.sequence),
  };
}
const array = (a: Uint8Array | number[]) => JSON.stringify([...a]);
export function restoreRecordCost(r: Revision) {
  const hashes = JSON.stringify(r.chunk_hashes.map((h) => [...h]));
  const pending = `{"vault":${array(r.vault)},"object":${array(r.object)},"revision":${r.revision},"plain_size":${r.plain_size},"manifest":${array(r.manifest)},"chunk_hashes":${hashes},"deleted":${r.deleted},"sequence":${r.sequence}}`;
  return {
    charge:
      (r.deleted ? 0n : 4096n) +
      r.plain_size +
      BigInt(r.chunk_hashes.length) * 4112n +
      BigInt(r.manifest.length) +
      BigInt(hashes.length) +
      4096n,
    pending: BigInt(pending.length),
  };
}
export function restorePreflight(
  j: RestoreAdmissionStatus,
  records: PortableRecord[],
  targetCommitment: Uint8Array,
  sequence: bigint,
): RestorePreflight {
  let revision_bytes = 0n,
    peak_pending_bytes = 0n,
    chunks = 0n,
    plain_bytes = 0n;
  const heads = new Map<string, Revision>();
  for (const portable of records) {
    const r = restoreRevision(portable),
      cost = restoreRecordCost(r);
    revision_bytes += cost.charge;
    peak_pending_bytes =
      peak_pending_bytes > cost.pending ? peak_pending_bytes : cost.pending;
    chunks += BigInt(r.chunk_hashes.length);
    plain_bytes += r.plain_size;
    heads.set(b64(bytes(r.object)), r);
  }
  const current_plain_bytes = [...heads.values()].reduce(
    (sum, r) => sum + (r.deleted ? 0n : r.plain_size),
    0n,
  );
  const f = {
    archive_digest: j.request.archive_digest,
    archive_length: j.request.archive_length,
    source_commitment: j.request.source_commitment,
    target_commitment: targetCommitment,
    sequence,
    records: BigInt(records.length),
    objects: BigInt(heads.size),
    chunks,
    revision_bytes,
    peak_pending_bytes,
    current_plain_bytes,
    plain_bytes,
    source_saved: true,
    source_fully_verified: true,
  };
  if (
    f.records > 10000n ||
    f.current_plain_bytes > 100n * 1024n * 1024n ||
    restoreReservation(f) > 200n * 1024n * 1024n ||
    f.peak_pending_bytes > 400000n
  )
    throw Error("QuotaExceeded");
  return f;
}
export function restoreReservation(f: RestorePreflight) {
  return f.revision_bytes + f.objects * 4096n + f.peak_pending_bytes;
}
