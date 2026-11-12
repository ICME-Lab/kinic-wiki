import { SaveWorkflow } from "./save-job";
import { strictJSON } from "../../vault-crypto/src/strict-json";
import { Principal } from "@icp-sdk/core/principal";
import { OrdinaryAuthority, cryptoGeneration } from "./ordinary";
import type {
  Generation,
  GrantPurpose,
  UnfinishedVault,
  CleanupProgress,
} from "./contracts";
import {
  generationAAD,
  generationBytes,
  sealV2,
  openV2,
  recoveryVerifier,
  utf8,
} from "../../vault-crypto/src/index";
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
  randomBytes,
} from "../../vault-crypto/src/index.ts";
import {
  pack,
  b64,
  unb64,
  readManifest,
  encryptDocument,
  decryptDocument,
  type Metadata,
} from "../../vault-crypto/src/documents.ts";
import {
  makeArchive,
  type PortableHeader,
  type PortableRecord,
} from "../../vault-backup/src/index.ts";
import { register } from "./webauthn.ts";
import { Session } from "./session.ts";
export const bytes = (x: Uint8Array | number[]) => new Uint8Array(x);
export function ok<T>(r: { Ok: T } | { Err: unknown }): T {
  if ("Ok" in r) return r.Ok;
  const e = r.Err;
  throw Error(e && typeof e === "object" ? Object.keys(e)[0] : "RequestFailed");
}
const ZERO = new Uint8Array(16);
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
  private headerValue?: Header;
  get header() {
    return this.headerValue;
  }
  set header(value: Header | undefined) {
    if (this.session.root) {
      if (!value || !("Active" in value.state)) {
        this.session.lock();
        throw Error("TargetChanged");
      }
      this.session.requireGeneration(value.generation[0]);
    }
    this.headerValue = value;
  }
  async refreshHeader() {
    const ticket = this.session.capture(),
      id = this.header?.id;
    if (!id) throw Error("Locked");
    const reply = await this.actor.get_vault_header(id);
    this.session.check(ticket);
    if ("Err" in reply) {
      if ("NotFound" in reply.Err) this.session.lock();
      return ok<Header>(reply);
    }
    this.header = reply.Ok;
    return reply.Ok;
  }
  private saves = new SaveWorkflow(
    this.session,
    () => this.actor,
    () => this.authority(),
    () => this.refreshHeader(),
  );
  get hasPendingSave() {
    return this.saves.pending;
  }
  resumeSave(progress: (n: number) => void = () => {}) {
    return this.saves.resume(progress);
  }
  async cancelUpload(header: Header, upload: Uint8Array) {
    const ticket = this.session.capture();
    if (
      this.saves.pending &&
      this.saves.upload &&
      b64(this.saves.upload) === b64(upload)
    )
      await this.saves.resolvePending();
    else if (this.authority().hasPending) await this.authority().retry();
    this.session.check(ticket);
    const status = ok(await this.actor.get_upload_status(upload));
    this.session.check(ticket);
    if ("Committed" in status || "Cancelled" in status || "Absent" in status) {
      if (this.saves.upload && b64(this.saves.upload) === b64(upload))
        this.saves.clear();
      return status;
    }
    if (
      "Pending" in status &&
      b64(bytes(status.Pending.request.vault)) !== b64(bytes(header.id))
    )
      throw Error("Unauthorized");
    const current = ok(await this.actor.get_vault_header(header.id));
    this.session.check(ticket);
    if (
      this.session.root &&
      this.header &&
      b64(bytes(this.header.id)) === b64(bytes(header.id))
    )
      this.header = current;
    if (this.saves.upload && b64(this.saves.upload) === b64(upload))
      this.saves.markCancelling();
    await this.authority().cleanup({ CancelUpload: { upload } }, [current]);
    this.session.check(ticket);
    const terminal = ok(await this.actor.get_upload_status(upload));
    this.session.check(ticket);
    if ("Pending" in terminal) throw Error("UploadCancelling");
    if (this.saves.upload && b64(this.saves.upload) === b64(upload))
      this.saves.clear();
    return terminal;
  }
  async cancelSave() {
    const upload = this.saves.upload;
    if (!upload || !this.header) throw Error("NoPendingSave");
    return this.cancelUpload(this.header, upload);
  }
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
  get recoveryConfiguration() {
    return { rpId: this.rpId, local: this.local };
  }
  configurePasskeys(rpId: string) {
    this.rpId = rpId;
  }
  destroy() {
    this.authorityValue?.destroy();
    this.authorityValue = undefined;
    this.session.lock();
    this.header = undefined;
    this.actorValue = undefined;
    this.identityValue = undefined;
    this.rpId = "";
  }
  private registerPasskey(
    ch: Parameters<typeof register>[0],
    owner: Uint8Array,
  ) {
    return register(ch, owner, this.rpId, this.session.signal);
  }
  private authorityValue?: OrdinaryAuthority;
  private authority() {
    return (this.authorityValue ??= new OrdinaryAuthority(
      this.actor,
      this.identity.getPrincipal(),
      Principal.fromText(this.canister),
      () => this.rpId,
      this.local,
      this.session,
    ));
  }
  selectCredential(id: Uint8Array | undefined) {
    this.authority().credential = id;
  }
  authorize(purpose: GrantPurpose, generations: Generation[]) {
    return this.authority().authorize(purpose, generations);
  }
  retryMutation() {
    return this.saves.pending ? this.resumeSave() : this.authority().retry();
  }
  private generation() {
    const g = this.header?.generation[0];
    if (!g) throw Error("LegacyRecoveryRequired");
    return this.session.root ? this.session.requireGeneration(g) : g;
  }
  async createKit() {
    this.session.lock();
    const g = this.session.capture(),
      vault = randomBytes(16),
      attempt = randomBytes(16);
    let raw: Uint8Array | undefined, secret: Uint8Array | undefined;
    const detach = this.session.addLockCleanup(() => {
      raw?.fill(0);
      secret?.fill(0);
    });
    try {
      const credentials = ok(await this.actor.list_credentials());
      this.session.check(g);
      let header: Header;
      if (!credentials.length)
        header = await this.authority().bootstrap(vault, attempt);
      else {
        await this.authorize({ Create: null }, []);
        let result = await this.authority().send({
          Create: { vault, operation: attempt },
        });
        if ("Handle" in result)
          result = await this.authority().send({
            KeyResult: { handle: result.Handle },
          });
        if (!("Header" in result)) throw Error("MissingHeader");
        header = result.Header;
        await this.authorize({ Normal: null }, [header.generation[0]!]);
      }
      this.session.check(g);
      this.header = header;
      const kek = await this.authority().derive(header, attempt);
      this.session.check(g);
      raw = randomBytes(32);
      secret = randomBytes(32);
      const normal = await sealV2(
        kek,
        raw,
        generationAAD(cryptoGeneration(this.generation()), ZERO, 0n, "normal"),
      );
      const recovery = await sealV2(
        await deriveKey(secret, "recovery"),
        raw,
        generationAAD(
          cryptoGeneration(this.generation()),
          ZERO,
          0n,
          "recovery",
        ),
      );
      const verifier = await recoveryVerifier(secret),
        root = await importKey(raw);
      this.session.check(g);
      this.session.bindRoot(root, this.generation(), raw);
      return {
        vault,
        attempt,
        normal,
        recovery,
        secret: b64(secret),
        recoveryVerifier: verifier,
        generation: g,
      };
    } catch (e) {
      raw?.fill(0);
      if (this.session.capture() === g) {
        this.authorityValue?.clear();
        this.session.raw = undefined;
        this.session.root = undefined;
        this.session.transport = undefined;
      }
      throw e;
    } finally {
      detach();
      secret?.fill(0);
    }
  }
  async activate(
    kit: Awaited<ReturnType<VaultClient["createKit"]>>,
    confirmation: string,
  ) {
    this.session.check(kit.generation);
    if (confirmation !== kit.secret)
      throw Error("RecoveryConfirmationMismatch");
    const result = await this.authority().send({
      Activate: {
        request: {
          vault: kit.vault,
          attempt: [kit.attempt],
          operation: randomBytes(16),
          normal: kit.normal,
          recovery: kit.recovery,
          registration: [],
          assertion: [],
        },
        recovery_verifier: kit.recoveryVerifier,
      },
    });
    this.session.check(kit.generation);
    if (!("Header" in result)) throw Error("MissingHeader");
    this.header = result.Header;
    return result.Header;
  }
  async unlock(header: Header) {
    this.session.lock();
    const g = this.session.capture();
    this.header = header;
    let raw: Uint8Array | undefined;
    try {
      await this.authorize({ Normal: null }, [this.generation()]);
      const kek = await this.authority().derive(header),
        current = ok(await this.actor.get_vault_header(header.id));
      this.session.check(g);
      if (!current.normal[0] || !current.generation[0])
        throw Error("InvalidEnvelope");
      raw = await openV2(
        kek,
        {
          ...current.normal[0],
          nonce: bytes(current.normal[0].nonce),
          ciphertext: bytes(current.normal[0].ciphertext),
        },
        generationAAD(
          cryptoGeneration(current.generation[0]),
          ZERO,
          0n,
          "normal",
        ),
      );
      const root = await importKey(raw);
      this.session.check(g);
      if (!("Active" in current.state)) throw Error("TargetChanged");
      this.session.bindRoot(root, current.generation[0], raw);
      this.header = current;
    } catch (e) {
      raw?.fill(0);
      if (this.session.capture() === g) {
        this.authorityValue?.clear();
        this.session.raw = undefined;
        this.session.root = undefined;
        this.session.transport = undefined;
      }
      throw e;
    }
  }
  async deleteObject(r: Revision) {
    return this.authority().normalSend(
      {
        DeleteObject: {
          vault: r.vault,
          object: r.object,
          expected_revision: r.revision,
          operation: randomBytes(16),
        },
      },
      this.generation(),
    );
  }
  async purgeObject(r: Revision) {
    return this.authority().normalSend(
      { PurgeObject: { vault: r.vault, object: r.object } },
      this.generation(),
    );
  }
  cleanup(
    header: Header,
    purge = false,
    progress?: (value: CleanupProgress) => void,
  ) {
    return this.authority().cleanup(
      purge ? { Purge: null } : { Expired: null },
      [header],
      undefined,
      progress,
    );
  }
  async cancelSetup(entry: UnfinishedVault) {
    const ticket = this.session.capture();
    if (!("Pending" in entry.state)) throw Error("Unauthorized");
    const credentials = ok(await this.actor.list_credentials());
    this.session.check(ticket);
    if (!credentials.length) {
      // Server permits only a never-activated, never-registered bootstrap here.
      // The immutable attempt remains mandatory even before nonce publication.
      ok(await this.actor.cancel_vault_setup(entry.vault, entry.attempt));
      this.session.check(ticket);
      return;
    }
    return this.authority().cleanup(
      { CancelSetup: { attempt: entry.attempt } },
      [],
      entry,
    );
  }
  async items() {
    const g = this.session.capture();
    if (!this.session.root || !this.header) throw Error("Locked");
    const generation = this.generation();
    await this.refreshHeader();
    this.session.check(g);
    const root = this.session.root!,
      v = bytes(generation.vault),
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
          cryptoGeneration(generation),
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
    await this.refreshHeader();
    this.session.check(g);
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
    if (this.saves.pending) throw Error("SavePending");
    if (this.authority().hasPending) throw Error("ResolvePendingMutation");
    const detach = this.session.addLockCleanup(() => plain.fill(0));
    try {
      const generation = this.generation(),
        root = this.session.root;
      await this.refreshHeader();
      this.session.check(g);
      const v = bytes(generation.vault),
        object = item ? bytes(item.revision.object) : randomBytes(16),
        expected = item?.revision.revision ?? 0n;
      const doc = await encryptDocument(
        root,
        v,
        object,
        expected + 1n,
        metadata,
        plain,
        cryptoGeneration(generation),
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
      this.saves.start(request, doc.chunks, generation);
      return await this.saves.resume(progress);
    } finally {
      detach();
    }
  }

  async read(r: Revision) {
    const g = this.session.capture();
    if (!this.session.root) throw Error("Locked");
    const generation = this.generation();
    await this.refreshHeader();
    this.session.check(g);
    const root = this.session.root!,
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
      cryptoGeneration(generation),
    );
    try {
      this.session.check(g);
      return doc;
    } catch (e) {
      doc.plaintext.fill(0);
      throw e;
    }
  }
  recoveryKit(kit: Awaited<ReturnType<VaultClient["createKit"]>>) {
    this.session.check(kit.generation);
    return utf8.encode(
      JSON.stringify({
        version: 2,
        generation: b64(generationBytes(cryptoGeneration(this.generation()))),
        secret: kit.secret,
      }),
    );
  }
  async backupWithKit(header: Header, data: Uint8Array) {
    if (data.length > 4096 || !header.generation[0]) throw Error("InvalidKit");
    const kit = strictJSON(
      new TextDecoder("utf-8", { fatal: true }).decode(data),
    ) as Record<string, unknown>;
    if (
      !kit ||
      Object.keys(kit).sort().join(",") !== "generation,secret,version" ||
      kit.version !== 2 ||
      typeof kit.secret !== "string" ||
      kit.generation !==
        b64(generationBytes(cryptoGeneration(header.generation[0])))
    )
      throw Error("InvalidKit");
    return this.backupWithRecovery(header, kit.secret);
  }
  async backupWithRecovery(header: Header, secretText: string) {
    const g = this.session.capture();
    const secret = unb64(secretText);
    let raw: Uint8Array | undefined;
    const detach = this.session.addLockCleanup(() => {
      secret.fill(0);
      raw?.fill(0);
    });
    try {
      const current = ok(await this.actor.get_vault_header(header.id));
      this.session.check(g);
      if (!current.recovery[0]) throw Error("InvalidEnvelope");
      const recovery = {
        ...current.recovery[0],
        nonce: bytes(current.recovery[0].nonce),
        ciphertext: bytes(current.recovery[0].ciphertext),
      };
      const key = await deriveKey(secret, "recovery");
      raw = current.generation[0]
        ? await openV2(
            key,
            recovery,
            generationAAD(
              cryptoGeneration(current.generation[0]),
              ZERO,
              0n,
              "recovery",
            ),
          )
        : await open(
            key,
            recovery,
            aad(bytes(current.id), ZERO, current.epoch, "recovery"),
          );
      this.session.check(g);
      return await this.buildBackup(current, raw, g);
    } finally {
      detach();
      secret.fill(0);
      raw?.fill(0);
    }
  }
  async backup() {
    const g = this.session.capture();
    if (!this.session.raw || !this.header) throw Error("Locked");
    this.generation();
    const header = await this.refreshHeader();
    this.session.check(g);
    return this.buildBackup(header, this.session.raw!, g);
  }
  private async buildBackup(headerValue: Header, raw: Uint8Array, g: number) {
    const v = bytes(headerValue.id);
    const active = ok(await this.actor.get_active_export_for_vault(v))[0];
    this.session.check(g);
    if (active && b64(bytes(active.vault)) !== b64(v)) throw Error("Busy");
    const e = active ?? ok(await this.actor.begin_export(v, randomBytes(16)));
    this.session.check(g);
    if (this.session.root) this.header = e.header;
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
    const ticket = this.session.capture();
    if (!this.header || !this.session.root) throw Error("Locked");
    await this.authorize({ Credentials: null }, []);
    const scope = { Global: null },
      vault = this.header.id;
    const ch = await this.authority().send({
      BeginRegistration: { vault, scope },
    });
    if (!("Challenge" in ch)) throw Error("MissingChallenge");
    const registration = await this.registerPasskey(
      ch.Challenge,
      this.identity.getPrincipal().toUint8Array(),
    );
    this.session.check(ticket);
    await this.authority().send({
      RegisterCredential: { vault, scope, registration },
    });
  }
  async removeCredential(id: Uint8Array) {
    if (!this.header || !this.session.root) throw Error("Locked");
    await this.authorize({ Credentials: null }, []);
    await this.authority().send({ RemoveCredential: { credential: id } });
    if (
      this.authority().credential &&
      b64(this.authority().credential!) === b64(id)
    )
      this.authority().credential = undefined;
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
    ...(h.generation[0]
      ? {
          envelope_revision: "0",
          generation: {
            version: 2 as const,
            canister: h.generation[0].canister.toText(),
            owner: h.generation[0].owner.toText(),
            vault: b64(bytes(h.generation[0].vault)),
            epoch: String(h.generation[0].epoch),
            nonce: b64(bytes(h.generation[0].nonce)),
            key_name: h.generation[0].key_name,
          },
          recovery_verifier: b64(bytes(h.recovery_verifier)),
        }
      : {}),
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
