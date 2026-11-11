import { type Identity } from "@icp-sdk/core/agent";
import {
  type VaultActor,
  type Header,
  type Revision,
  type Envelope as WireEnvelope,
} from "./contracts";
import {
  aad,
  deriveKey,
  importKey,
  open,
  seal,
  randomBytes,
  TransportSecretKey,
  verifiedKEK,
  utf8,
} from "../../vault-crypto/src/index.ts";
import {
  pack,
  unpack,
  b64,
  unb64,
  readManifest,
  encryptDocument,
  decryptDocument,
  type Metadata,
} from "../../vault-crypto/src/documents.ts";
import {
  makeArchive,
  openArchive,
  type PortableHeader,
  type PortableRecord,
} from "../../vault-backup/src/index.ts";
import { register, assertCredential } from "./webauthn.ts";
import { Session } from "./session.ts";
export const bytes = (x: Uint8Array | number[]) => new Uint8Array(x);
export function ok<T>(r: { Ok: T } | { Err: unknown }): T {
  if ("Ok" in r) return r.Ok;
  const e = r.Err;
  throw Error(e && typeof e === "object" ? Object.keys(e)[0] : "RequestFailed");
}
const ZERO = new Uint8Array(16),
  TRANSPORT = new Uint8Array(48);
export type Item = {
  revision: Revision;
  metadata: Metadata;
  searchText?: string;
};
export class VaultClient {
  private actorValue?: VaultActor;
  private identityValue?: Identity;
  get actor(): VaultActor {
    if (!this.actorValue) throw Error("NotSignedIn");
    return this.actorValue;
  }
  get identity(): Identity {
    if (!this.identityValue) throw Error("NotSignedIn");
    return this.identityValue;
  }
  session = new Session();
  canister = "";
  header?: Header;
  private local = false;
  private rpId = "";
  constructor(options?: {
    actor: VaultActor;
    identity: Identity;
    canister: string;
    local: boolean;
    rpId?: string;
  }) {
    if (options) {
      this.actorValue = options.actor;
      this.identityValue = options.identity;
      this.canister = options.canister;
      this.local = options.local;
      this.rpId = options.rpId ?? "";
    }
  }
  configurePasskeys(rpId: string) {
    this.rpId = rpId;
  }
  destroy() {
    this.session.lock();
    this.header = undefined;
    this.actorValue = undefined;
    this.identityValue = undefined;
    this.rpId = "";
  }
  private assertPasskey(ch: Parameters<typeof assertCredential>[0]) {
    return assertCredential(ch, this.rpId, this.session.signal);
  }
  private registerPasskey(
    ch: Parameters<typeof register>[0],
    owner: Uint8Array,
  ) {
    return register(ch, owner, this.rpId, this.session.signal);
  }
  async challenge(
    vault: Uint8Array,
    purpose: "Activate" | "Unlock" | "AddCredential" | "RemoveCredential",
    transport: Uint8Array = TRANSPORT,
    target: Uint8Array = new Uint8Array(),
    attempt?: Uint8Array,
  ) {
    return ok(
      await this.actor.begin_unlock({
        vault,
        epoch: this.header?.epoch ?? 0n,
        purpose: { [purpose]: null } as never,
        transport,
        target,
        attempt: attempt ? [attempt] : [],
      }),
    );
  }
  async createKit() {
    this.session.lock();
    const g = this.session.capture(),
      vault = randomBytes(16),
      attempt = randomBytes(16);
    const header = ok(
      await this.actor.reserve_vault({ vault, operation: attempt }),
    );
    this.session.check(g);
    this.header = header;
    try {
      this.session.transport = TransportSecretKey.random();
      const transportPublic = this.session.transport.publicKeyBytes();
      const reply = ok(
        await this.actor.derive_vault_key({
          vault,
          epoch: 0n,
          transport: transportPublic,
          assertion: [],
          attempt: [attempt],
        }),
      );
      this.session.check(g);
      const pendingKey = verifiedKEK(
        bytes(reply.encrypted_key),
        this.session.transport!,
        this.canister,
        vault,
        0n,
        this.local,
        this.identity.getPrincipal().toUint8Array(),
        header.key_name,
      );
      this.session.transport = undefined;
      const kek = await pendingKey;
      this.session.check(g);
      const raw = randomBytes(32),
        secret = randomBytes(32);
      try {
        const normal = await seal(kek, raw, aad(vault, ZERO, 0n, "normal"));
        const recovery = await seal(
          await deriveKey(secret, "recovery"),
          raw,
          aad(vault, ZERO, 0n, "recovery"),
        );
        this.session.check(g);
        const root = await importKey(raw);
        this.session.check(g);
        this.session.raw = raw;
        this.session.root = root;
        return {
          vault,
          attempt,
          normal,
          recovery,
          secret: b64(secret),
          generation: g,
        };
      } catch (e) {
        raw.fill(0);
        throw e;
      } finally {
        secret.fill(0);
      }
    } catch (e) {
      if (this.session.capture() === g) this.session.lock();
      throw e;
    }
  }
  async activate(
    kit: Awaited<ReturnType<VaultClient["createKit"]>>,
    confirmation: string,
  ) {
    const g = kit.generation;
    this.session.check(g);
    if (confirmation !== kit.secret)
      throw Error("RecoveryConfirmationMismatch");
    const ch = await this.challenge(
      kit.vault,
      "Activate",
      undefined,
      undefined,
      kit.attempt,
    );
    this.session.check(g);
    const registration = ch.registration
      ? await this.registerPasskey(
          ch,
          this.identity.getPrincipal().toUint8Array(),
        )
      : undefined;
    const assertion = ch.registration
      ? undefined
      : await this.assertPasskey(ch);
    this.session.check(g);
    const header = ok(
      await this.actor.activate_vault({
        vault: kit.vault,
        attempt: [kit.attempt],
        operation: randomBytes(16),
        normal: kit.normal,
        recovery: kit.recovery,
        registration: registration ? [registration] : [],
        assertion: assertion ? [assertion] : [],
      }),
    );
    this.session.check(g);
    this.header = header;
    return header;
  }
  async unlock(header: Header) {
    this.session.lock();
    const g = this.session.capture();
    this.header = header;
    try {
      this.session.transport = TransportSecretKey.random();
      const transportPublic = this.session.transport.publicKeyBytes();
      const ch = await this.challenge(
        bytes(header.id),
        "Unlock",
        transportPublic,
      );
      this.session.check(g);
      const assertion = await this.assertPasskey(ch);
      this.session.check(g);
      const reply = ok(
        await this.actor.derive_vault_key({
          vault: header.id,
          epoch: header.epoch,
          transport: transportPublic,
          assertion: [assertion],
          attempt: [],
        }),
      );
      this.session.check(g);
      const pendingKey = verifiedKEK(
        bytes(reply.encrypted_key),
        this.session.transport!,
        this.canister,
        bytes(header.id),
        header.epoch,
        this.local,
        this.identity.getPrincipal().toUint8Array(),
        header.key_name,
      );
      this.session.transport = undefined;
      const kek = await pendingKey;
      this.session.check(g);
      const current = ok(await this.actor.get_vault_header(header.id));
      this.session.check(g);
      if (!current.normal[0]) throw Error("InvalidEnvelope");
      const raw = await open(
        kek,
        {
          version: current.normal[0].version,
          nonce: bytes(current.normal[0].nonce),
          ciphertext: bytes(current.normal[0].ciphertext),
        },
        aad(bytes(current.id), ZERO, current.epoch, "normal"),
      );
      try {
        const root = await importKey(raw);
        this.session.check(g);
        this.session.root = root;
        this.session.raw = raw;
        this.header = current;
      } catch (e) {
        raw.fill(0);
        throw e;
      }
    } catch (e) {
      if (this.session.capture() === g) this.session.lock();
      throw e;
    }
  }
  async items() {
    const g = this.session.capture();
    if (!this.session.root || !this.header) throw Error("Locked");
    const root = this.session.root,
      v = bytes(this.header.id),
      items: Item[] = [];
    let cursor: Uint8Array = new Uint8Array();
    do {
      const p = ok(await this.actor.list_objects(v, cursor));
      this.session.check(g);
      for (const r of p.entries) {
        let source = r;
        if (r.deleted) {
          const history = ok(
            await this.actor.list_history(
              r.vault,
              r.object,
              18446744073709551615n,
            ),
          );
          this.session.check(g);
          const previous = history.entries.find((x) => !x.deleted);
          if (!previous) {
            items.push({
              revision: r,
              metadata: { kind: "note", title: "Deleted document" },
            });
            continue;
          }
          source = previous;
        }
        const parsed = await readManifest(
          root,
          v,
          bytes(source.object),
          source.revision,
          bytes(source.manifest),
        );
        this.session.check(g);
        let searchText = parsed.metadata.title;
        if (parsed.metadata.kind === "note" && !r.deleted) {
          const doc = await this.read(r);
          try {
            this.session.check(g);
            searchText += " " + new TextDecoder().decode(doc.plaintext);
          } finally {
            doc.plaintext.fill(0);
          }
        }
        items.push({ revision: r, metadata: parsed.metadata, searchText });
      }
      cursor = p.next[0] ? bytes(p.next[0]) : new Uint8Array();
    } while (cursor.length);
    return items;
  }
  async save(
    metadata: Metadata,
    plain: Uint8Array,
    item: Item | undefined,
    progress: (n: number) => void,
  ) {
    const g = this.session.capture();
    if (!this.session.root || !this.header) throw Error("Locked");
    const v = bytes(this.header.id),
      object = item ? bytes(item.revision.object) : randomBytes(16),
      expected = item?.revision.revision ?? 0n;
    const doc = await encryptDocument(
      this.session.root,
      v,
      object,
      expected + 1n,
      metadata,
      plain,
    );
    this.session.check(g);
    const operation = randomBytes(16);
    const request = {
      vault: v,
      object,
      expected_revision: expected,
      operation,
      plain_size: BigInt(plain.length),
      manifest: doc.manifest,
      chunk_hashes: doc.hashes,
    };
    await this.retry(() => this.actor.begin_revision(request), g);
    for (let i = 0; i < doc.chunks.length; i++) {
      await this.retry(
        () => this.actor.put_chunk(operation, i, doc.chunks[i]),
        g,
      );
      this.session.check(g);
      progress(Math.round(((i + 1) / doc.chunks.length) * 100));
    }
    const r = await this.retry(() => this.actor.commit_revision(operation), g);
    this.session.check(g);
    const header = ok(await this.actor.get_vault_header(v));
    this.session.check(g);
    this.header = header;
    return r;
  }
  private async retry<T>(
    call: () => Promise<{ Ok: T } | { Err: unknown }>,
    g: number,
  ) {
    for (let i = 0; ; i++) {
      this.session.check(g);
      let response;
      try {
        response = await call();
      } catch (e) {
        if (i >= 2) throw Error("ConnectionInterrupted");
        continue;
      }
      this.session.check(g);
      return ok(response);
    }
  }
  async read(r: Revision) {
    const g = this.session.capture();
    if (!this.session.root) throw Error("Locked");
    const root = this.session.root,
      chunks: Uint8Array[] = [];
    for (let i = 0; i < r.chunk_hashes.length; i++) {
      chunks.push(
        bytes(ok(await this.actor.get_chunk(r.vault, r.object, r.revision, i))),
      );
      this.session.check(g);
    }
    const doc = await decryptDocument(
      root,
      bytes(r.vault),
      bytes(r.object),
      r.revision,
      bytes(r.manifest),
      chunks,
      r.chunk_hashes.map(bytes),
    );
    try {
      this.session.check(g);
      return doc;
    } catch (e) {
      doc.plaintext.fill(0);
      throw e;
    }
  }
  async backupWithRecovery(header: Header, secretText: string) {
    const g = this.session.capture();
    const secret = unb64(secretText);
    let raw: Uint8Array | undefined;
    try {
      const current = ok(await this.actor.get_vault_header(header.id));
      this.session.check(g);
      if (!current.recovery[0]) throw Error("InvalidEnvelope");
      raw = await open(
        await deriveKey(secret, "recovery"),
        {
          version: current.recovery[0].version,
          nonce: bytes(current.recovery[0].nonce),
          ciphertext: bytes(current.recovery[0].ciphertext),
        },
        aad(bytes(current.id), ZERO, current.epoch, "recovery"),
      );
      this.session.check(g);
      return await this.buildBackup(current, raw, g);
    } finally {
      secret.fill(0);
      raw?.fill(0);
    }
  }
  async backup() {
    const g = this.session.capture();
    if (!this.session.raw || !this.header) throw Error("Locked");
    return this.buildBackup(this.header, this.session.raw, g);
  }
  private async buildBackup(headerValue: Header, raw: Uint8Array, g: number) {
    const v = bytes(headerValue.id);
    const active = ok(await this.actor.get_active_export_for_vault(v))[0];
    this.session.check(g);
    if (active && b64(bytes(active.vault)) !== b64(v)) throw Error("Busy");
    const e = active ?? ok(await this.actor.begin_export(v, randomBytes(16)));
    this.session.check(g);
    const records: PortableRecord[] = [];
    let after = 0n;
    do {
      const p = ok(await this.actor.export_index(e.id, after));
      this.session.check(g);
      records.push(...p.entries.map(portableRecord));
      after = p.next[0] ?? 0n;
    } while (after);
    const header = portableHeader(e.header, {
      record_count: Number(e.record_count),
      chunk_count: Number(e.chunk_count),
      plain_bytes: String(e.plain_bytes),
    });
    const data = await makeArchive(
      header,
      records,
      async (r, i) => {
        const c = bytes(
          ok(
            await this.actor.get_export_chunk(
              e.id,
              unb64(r.object),
              BigInt(r.revision),
              i,
            ),
          ),
        );
        this.session.check(g);
        return c;
      },
      raw,
    );
    this.session.check(g);
    return { exportId: bytes(e.id), data };
  }
  async confirmBackup(id: Uint8Array, saved: boolean) {
    const g = this.session.capture();
    const header = ok(await this.actor.finish_export(id, saved));
    this.session.check(g);
    this.header = header;
  }
  async addCredential() {
    const g = this.session.capture();
    if (!this.header || !this.session.root) throw Error("Locked");
    const v = bytes(this.header.id),
      ch = await this.challenge(v, "AddCredential");
    this.session.check(g);
    const registration = await this.registerPasskey(
      ch,
      this.identity.getPrincipal().toUint8Array(),
    );
    this.session.check(g);
    const target = bytes(
      ok(await this.actor.prepare_unlock_credential(v, registration)),
    );
    this.session.check(g);
    const auth = await this.challenge(v, "AddCredential", TRANSPORT, target);
    this.session.check(g);
    const assertion = await this.assertPasskey(auth);
    this.session.check(g);
    ok(
      await this.actor.manage_unlock_credential({
        vault: v,
        remove: [],
        registration: [registration],
        assertion,
      }),
    );
    this.session.check(g);
  }
  async removeCredential(id: Uint8Array) {
    const g = this.session.capture();
    if (!this.header || !this.session.root) throw Error("Locked");
    const v = bytes(this.header.id),
      ch = await this.challenge(v, "RemoveCredential", TRANSPORT, id);
    this.session.check(g);
    const assertion = await this.assertPasskey(ch);
    this.session.check(g);
    ok(
      await this.actor.manage_unlock_credential({
        vault: v,
        remove: [id],
        registration: [],
        assertion,
      }),
    );
    this.session.check(g);
  }
  async restore(data: Uint8Array, secretText: string, resetSession = true) {
    if (resetSession) this.session.lock();
    const g = this.session.capture();
    const secret = unb64(secretText);
    let archive;
    let completed = false;
    try {
      archive = await openArchive(data, secret);
      this.session.check(g);
      this.session.raw = archive.rootRaw;
      this.session.root = archive.root;
      archive.root = undefined as never;
      const h = archive.header;
      const original: Header = {
        generation: [], recovery_verifier: [],
        id: unb64(h.vault),
        epoch: BigInt(h.epoch),
        sequence: BigInt(h.sequence),
        state: { Active: null },
        normal: [unpack(h.normal)],
        recovery: [unpack(h.recovery)],
        backup_sequence: [],
        backup_at: [],
        key_name: h.key_name,
      };
      // Conservative reservation covers SQL metadata and chunk/page overhead. Backend independently checks every byte.
      const reserved =
        archive.records.reduce(
          (n, r) =>
            n +
            Number(r.plain_size) +
            r.hashes.length * (16 + 4096) +
            unb64(r.manifest).length +
            JSON.stringify(r.hashes.map(unb64).map((x) => Array.from(x)))
              .length +
            4096,
          0,
        ) +
        new Set(archive.records.map((r) => r.object)).size * 4096 +
        1048576;
      const attempt = randomBytes(16);
      const restoring = ok(
        await this.actor.begin_restore({
          header: original,
          operation: attempt,
          count: BigInt(archive.records.length),
          root: archive.restoreRoot,
          reserved_bytes: BigInt(reserved),
        }),
      );
      this.session.check(g);
      this.header = restoring;
      for (let i = 0; i < archive.records.length; i++) {
        const r = archive.records[i];
        ok(
          await this.actor.begin_restore_revision(original.id, wireRecord(r), [
            attempt,
          ]),
        );
        this.session.check(g);
        for (let j = 0; j < archive.chunks[i].length; j++) {
          ok(
            await this.actor.put_restore_chunk(
              original.id,
              j,
              archive.chunks[i][j],
              [attempt],
            ),
          );
          this.session.check(g);
        }
        ok(
          await this.actor.commit_restore_revision(
            original.id,
            BigInt(r.sequence),
            [attempt],
          ),
        );
        this.session.check(g);
      }
      this.session.transport = TransportSecretKey.random();
      const transportPublic = this.session.transport.publicKeyBytes();
      const reply = ok(
        await this.actor.derive_vault_key({
          vault: original.id,
          epoch: original.epoch,
          transport: transportPublic,
          assertion: [],
          attempt: [attempt],
        }),
      );
      this.session.check(g);
      const pendingKey = verifiedKEK(
        bytes(reply.encrypted_key),
        this.session.transport!,
        this.canister,
        bytes(original.id),
        original.epoch,
        this.local,
        this.identity.getPrincipal().toUint8Array(),
        restoring.key_name,
      );
      this.session.transport = undefined;
      const kek = await pendingKey;
      const normal = await seal(
        kek,
        archive.rootRaw,
        aad(bytes(original.id), ZERO, original.epoch, "normal"),
      );
      this.session.check(g);
      const ch = await this.challenge(
        bytes(original.id),
        "Activate",
        undefined,
        undefined,
        attempt,
      );
      this.session.check(g);
      const registration = ch.registration
        ? await this.registerPasskey(
            ch,
            this.identity.getPrincipal().toUint8Array(),
          )
        : undefined;
      const assertion = ch.registration
        ? undefined
        : await this.assertPasskey(ch);
      this.session.check(g);
      const restored = ok(
        await this.actor.commit_restore({
          vault: original.id,
          attempt: [attempt],
          operation: randomBytes(16),
          normal,
          recovery: unpack(h.recovery),
          registration: registration ? [registration] : [],
          assertion: assertion ? [assertion] : [],
        }),
      );
      this.session.check(g);
      this.header = restored;
      this.session.raw = new Uint8Array(archive.rootRaw);
      completed = true;
    } finally {
      if (!completed && this.session.capture() === g) this.session.lock();
      secret.fill(0);
      archive?.rootRaw.fill(0);
    }
  }
}
export function portableHeader(
  h: Header,
  stats: { record_count: number; chunk_count: number; plain_bytes: string },
): PortableHeader {
  if (!h.normal[0] || !h.recovery[0]) throw Error("InvalidHeader");
  const env = (e: WireEnvelope) =>
    pack({
      version: e.version,
      nonce: bytes(e.nonce),
      ciphertext: bytes(e.ciphertext),
    });
  return {
    version: h.generation[0] ? 2 : 1,
    ...(h.generation[0] ? {generation:{version:2 as const,canister:h.generation[0].canister.toText(),owner:h.generation[0].owner.toText(),vault:b64(bytes(h.generation[0].vault)),epoch:String(h.generation[0].epoch),nonce:b64(bytes(h.generation[0].nonce)),key_name:h.generation[0].key_name},recovery_verifier:b64(bytes(h.recovery_verifier))} : {}),
    ...stats,
    vault: b64(bytes(h.id)),
    epoch: String(h.epoch),
    sequence: String(h.sequence),
    key_name: h.key_name,
    normal: env(h.normal[0]),
    recovery: env(h.recovery[0]),
  };
}
export function portableRecord(r: Revision): PortableRecord {
  return {
    vault: b64(bytes(r.vault)),
    object: b64(bytes(r.object)),
    revision: String(r.revision),
    sequence: String(r.sequence),
    plain_size: String(r.plain_size),
    manifest: b64(bytes(r.manifest)),
    hashes: r.chunk_hashes.map((x) => b64(bytes(x))),
    deleted: r.deleted,
  };
}
export function wireRecord(r: PortableRecord): Revision {
  return {
    vault: unb64(r.vault),
    object: unb64(r.object),
    revision: BigInt(r.revision),
    sequence: BigInt(r.sequence),
    plain_size: BigInt(r.plain_size),
    manifest: unb64(r.manifest),
    chunk_hashes: r.hashes.map(unb64),
    deleted: r.deleted,
  };
}
