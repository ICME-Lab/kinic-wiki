import { grantProof } from "./grant-proof";
/** Fresh scoped restore; all files and secrets remain local, all server effects are signed. */
import { Principal } from "@icp-sdk/core/principal";
import type {
  VaultActor,
  RestoreAdmissionStatus,
  Generation,
  GrantPurpose,
  IncidentTarget,
  RestoreCandidateMode,
} from "./contracts";
import { Session } from "./session";
import { SignedMutations, grantBinding, authorityContext } from "./signed";
import { register, assertCredential } from "./webauthn";
import { bytes, ok } from "./wire";
import { cryptoGeneration, encodeIncidentKit, verifyIncidentKit } from "./incident";
import { portableExport, portableRecord } from "./incident-backup";
import { restorePreflight, restoreRevision } from "./restore-cost";
import { b64, unb64, hash, unpack, pack } from "../../vault-crypto/src/documents";
import {
  randomBytes,
  generationBytes,
  recoverySigningKey,
  recoveryVerifier,
  verifiedGenerationKEK,
  TransportSecretKey,
} from "../../vault-crypto/src/index";
import { strictJSON } from "../../vault-crypto/src/strict-json";
import {
  openArchive,
  transformArchive,
  headerGeneration,
  makeArchive,
  targetRestoreRoot,
  type PortableRecord,
} from "../../vault-backup/src/index";
const equal = (a: Uint8Array | number[], b: Uint8Array | number[]) =>
  b64(bytes(a)) === b64(bytes(b));
export function sameRestoreGeneration(a: Generation, b: Generation) {
  try {
    return equal(
      generationBytes(cryptoGeneration(a)),
      generationBytes(cryptoGeneration(b)),
    );
  } catch {
    return false;
  }
}
function canonical(value: unknown): string {
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
type Save = (file: Uint8Array) => Promise<void>;
type Select = () => Promise<Uint8Array>;
export function kitSecret(kit: Uint8Array, g: Generation) {
  if (kit.length > 4096) throw Error("InvalidKit");
  const k = strictJSON(
    new TextDecoder("utf-8", { fatal: true }).decode(kit),
  ) as Record<string, unknown>;
  if (
    !k ||
    Object.keys(k).sort().join(",") !== "generation,secret,version" ||
    k.version !== 2 ||
    k.generation !== b64(generationBytes(cryptoGeneration(g))) ||
    typeof k.secret !== "string"
  )
    throw Error("InvalidKit");
  const secret = unb64(k.secret);
  if (secret.length !== 32) {
    secret.fill(0);
    throw Error("InvalidKit");
  }
  return secret;
}
function target(j: RestoreAdmissionStatus) {
  const p = j.pipeline[0];
  if (!p) throw Error("TargetNotAllocated");
  return p;
}
const kitTarget = (j: RestoreAdmissionStatus) => {
  const p = target(j);
  return {
    target: [p.target],
    normal: p.normal,
    recovery: p.recovery,
    recovery_verifier: p.recovery_verifier,
  } as unknown as IncidentTarget;
};
export class RestoreClient {
  private signer?: SignedMutations;
  private reuse?: { binding: Uint8Array; context: string };
  private proofContext?: string;
  private authority(j: RestoreAdmissionStatus) {
    return authorityContext([
      j.request,
      j.challenge,
      j.phase,
      j.candidate,
      j.candidate_digest,
      j.existing_candidate,
      j.current_live,
      j.current_verifier,
      j.semantic_config,
      j.proof_fence,
      j.issued,
      j.cancel_requested,
      j.parent_job,
      j.pipeline[0]?.target,
    ]);
  }
  private rememberProof(j: RestoreAdmissionStatus) {
    this.proofContext = this.authority(j);
    return j;
  }
  private detach: () => void;
  constructor(
    private actor: VaultActor,
    private owner: Principal,
    private canister: Principal,
    private rpId: string,
    private local: boolean,
    readonly session = new Session(),
  ) {
    this.detach = session.addLockCleanup(() => {
      this.signer?.destroy();
      this.signer = undefined;
      this.reuse = undefined;
      this.proofContext = undefined;
    });
  }
  destroy() {
    this.session.lock();
    this.signer?.destroy();
    this.signer = undefined;
    this.reuse = undefined;
    this.proofContext = undefined;
    this.detach();
  }
  private signed() {
    if (!this.signer) throw Error("FreshRestoreProofRequired");
    return this.signer;
  }
  async status() {
    const ticket = this.session.capture(),
      j = ok(await this.actor.restore_admission_status())[0];
    this.session.check(ticket);
    if (!j) throw Error("NoRestore");
    return j;
  }
  async authenticate(credential: Uint8Array, purpose: GrantPurpose) {
    if (this.signer?.hasPending) throw Error("ResolvePendingMutation");
    this.reuse = undefined;
    try {
      const ticket = this.session.capture();
      const { grant: g, keys } = await grantProof(
        this.session, this.rpId, { credential, purpose, generations: [] },
        this.actor.begin_restore_grant,
        (operation, proof) => this.actor.finish_restore_grant(operation, proof, "RestoreCleanup" in purpose),
      );
      this.session.check(ticket);
      this.signer?.destroy();
      this.signer = new SignedMutations(
        this.actor,
        this.owner,
        this.canister,
        g,
        keys,
      );
      this.reuse = {
        binding: grantBinding(credential, purpose, []),
        context: this.proofContext ?? "",
      };
    } catch (error) {
      this.proofContext = undefined;
      throw error;
    }
  }
  async ensureAuthenticated(credential: Uint8Array, purpose: GrantPurpose) {
    if (this.signer?.hasPending) throw Error("ResolvePendingMutation");
    const current = await this.status(),
      binding = grantBinding(credential, purpose, []);
    if (
      this.signer?.reusable &&
      this.reuse &&
      equal(binding, this.reuse.binding) &&
      this.authority(current) === this.reuse.context
    )
      return;
    return this.authenticate(credential, purpose);
  }
  private async proveCurrent(j: RestoreAdmissionStatus, secret?: Uint8Array) {
    if (!j.current_live[0]) return j;
    if (!secret) throw Error("CurrentLiveKitRequired");
    const ticket = this.session.capture(),
      key = await recoverySigningKey(secret);
    this.session.check(ticket);
    // The server message already contains the recovery domain exactly once.
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        "Ed25519",
        key,
        new Uint8Array(j.recovery_message),
      ),
    );
    this.session.check(ticket);
    const result = ok(
      await this.actor.prove_restore_current(j.request.job, signature),
    );
    this.session.check(ticket);
    return result;
  }
  async admit(
    namespace: Uint8Array,
    archive: Uint8Array,
    sourceSecret: Uint8Array,
    saveSource: Save,
    currentSecret?: Uint8Array,
    existingCredential?: Uint8Array,
  ) {
    if (this.signer?.hasPending) throw Error("ResolvePendingMutation");
    const ticket = this.session.capture(),
      source = await openArchive(archive, sourceSecret);
    const detach = this.session.addLockCleanup(() => source.rootRaw.fill(0));
    try {
      this.session.check(ticket);
      await saveSource(archive);
      this.session.check(ticket);
      const digest = await hash(archive);
      this.session.check(ticket);
      const g = headerGeneration(source.header);
      const request = {
        candidate_mode: existingCredential
          ? ([{ ExistingInstances: existingCredential }] as [
              RestoreCandidateMode,
            ])
          : ([] as []),
        job: randomBytes(16),
        target: {
          namespace,
          vault: unb64(source.header.vault),
          attempt: randomBytes(16),
        },
        archive_digest: digest,
        source_commitment: source.restoreRoot,
        source_epoch: BigInt(source.header.epoch),
        source_generation: g
          ? ([
              {
                ...g,
                canister: Principal.fromText(g.canister),
                owner: Principal.fromText(g.owner),
              },
            ] as [Generation])
          : ([] as []),
        archive_length: BigInt(archive.length),
        records: BigInt(source.records.length),
        reserved_bytes: 0n,
      };
      let ch = ok(await this.actor.begin_restore_admission(request));
      this.session.check(ticket);
      if (existingCredential) {
        if (
          ch.registration ||
          ch.credential_ids.length !== 1 ||
          !equal(ch.credential_ids[0], existingCredential)
        )
          throw Error("RestoreCandidateChanged");
      } else {
        const registration = await register(
          ch,
          this.owner.toUint8Array(),
          this.rpId,
          this.session.signal,
        );
        this.session.check(ticket);
        ch = ok(
          await this.actor.register_restore_candidate(
            request.job,
            registration,
          ),
        );
        this.session.check(ticket);
      }
      const proof = await assertCredential(ch, this.rpId, this.session.signal);
      this.session.check(ticket);
      const j = ok(
        await this.actor.prove_restore_candidate(request.job, proof),
      );
      this.session.check(ticket);
      return this.rememberProof(await this.proveCurrent(j, currentSecret));
    } finally {
      detach();
      source.rootRaw.fill(0);
    }
  }
  private async verifySource(
    j: RestoreAdmissionStatus,
    archive: Uint8Array,
    secret: Uint8Array,
  ) {
    const ticket = this.session.capture(),
      source = await openArchive(archive, secret);
    try {
      this.session.check(ticket);
      const digest = await hash(archive);
      this.session.check(ticket);
      if (
        !equal(digest, j.request.archive_digest) ||
        BigInt(archive.length) !== j.request.archive_length ||
        !equal(source.restoreRoot, j.request.source_commitment)
      )
        throw Error("SourceChanged");
      return source;
    } catch (e) {
      source.rootRaw.fill(0);
      throw e;
    }
  }
  /** Every selected archive is still fully opened and verified before reusing live proof. */
  async ensureResumed(
    archive: Uint8Array,
    sourceSecret: Uint8Array,
    currentSecret?: Uint8Array,
  ) {
    if (this.signer?.hasPending) throw Error("ResolvePendingMutation");
    try {
      const ticket = this.session.capture(),
        j = await this.status();
      const source = await this.verifySource(j, archive, sourceSecret);
      source.rootRaw.fill(0);
      this.session.check(ticket);
      if (j.current_live[0]) {
        if (!currentSecret) throw Error("CurrentLiveKitRequired");
        if (!equal(await recoveryVerifier(currentSecret), j.current_verifier)) {
          this.proofContext = undefined;
          this.reuse = undefined;
          throw Error("CurrentLiveKitRequired");
        }
        this.session.check(ticket);
      }
      if (
        this.proofContext === this.authority(j) &&
        j.challenge.expires > BigInt(Math.floor(Date.now() / 1000)) &&
        (!this.signer || this.signer.reusable)
      )
        return j;
      this.proofContext = undefined;
      this.reuse = undefined;
      return await this.resume(archive, sourceSecret, currentSecret);
    } catch (error) {
      this.proofContext = undefined;
      this.reuse = undefined;
      throw error;
    }
  }
  async resume(
    archive: Uint8Array,
    sourceSecret: Uint8Array,
    currentSecret?: Uint8Array,
  ) {
    if (this.signer?.hasPending) throw Error("ResolvePendingMutation");
    this.proofContext = undefined;
    this.reuse = undefined;
    const ticket = this.session.capture(),
      j = await this.status(),
      source = await this.verifySource(j, archive, sourceSecret);
    const detach = this.session.addLockCleanup(() => source.rootRaw.fill(0));
    try {
      this.session.check(ticket);
      let ch = ok(await this.actor.resume_restore_admission(j.request.job));
      this.session.check(ticket);
      const existing = j.request.candidate_mode?.[0];
      if (
        existing &&
        "ExistingInstances" in existing &&
        (ch.registration ||
          ch.credential_ids.length !== 1 ||
          !equal(ch.credential_ids[0], existing.ExistingInstances))
      )
        throw Error("RestoreCandidateChanged");
      if (ch.registration) {
        const registration = await register(
          ch,
          this.owner.toUint8Array(),
          this.rpId,
          this.session.signal,
        );
        this.session.check(ticket);
        ch = ok(
          await this.actor.register_restore_candidate(
            j.request.job,
            registration,
          ),
        );
        this.session.check(ticket);
      }
      if (ch.registration || ch.credential_ids.length !== 1)
        throw Error("RestoreCandidateChanged");
      const proof = await assertCredential(ch, this.rpId, this.session.signal);
      this.session.check(ticket);
      const fresh = ok(
        await this.actor.prove_restore_candidate(j.request.job, proof),
      );
      this.session.check(ticket);
      return this.rememberProof(await this.proveCurrent(fresh, currentSecret));
    } finally {
      detach();
      source.rootRaw.fill(0);
    }
  }
  async allocate() {
    const ticket = this.session.capture();
    await this.signed().send({ RestoreAllocate: null });
    this.session.check(ticket);
    return this.status();
  }
  async deriveTarget(j: RestoreAdmissionStatus) {
    const ticket = this.session.capture(),
      g = target(j).target;
    if (
      g.owner.toText() !== this.owner.toText() ||
      g.canister.toText() !== this.canister.toText()
    )
      throw Error("WrongNamespace");
    const transport = TransportSecretKey.random();
    const h = await this.signed().send({
      RestoreDerive: {
        job: j.request.job,
        attempt: j.request.target.attempt,
        role: { Target: null },
        generation: g,
        transport: transport.publicKeyBytes(),
      },
    });
    this.session.check(ticket);
    if (!("Handle" in h)) throw Error("MissingKeyHandle");
    const r = await this.signed().send({ KeyResult: { handle: h.Handle } });
    this.session.check(ticket);
    if (!("Key" in r)) throw Error("MissingKeyResult");
    const kek = await verifiedGenerationKEK(
      bytes(r.Key.encrypted_key),
      transport,
      cryptoGeneration(g),
      this.local,
    );
    this.session.check(ticket);
    return kek;
  }
  /** The prepared encrypted archive is a local resume artifact; the final backup is read back from the server. */
  async prepare(
    archive: Uint8Array,
    sourceSecret: Uint8Array,
    saveKit: Save,
    reselectKit: Select,
    savePrepared: Save,
    reselectPrepared: Select,
  ) {
    const ticket = this.session.capture(),
      j = await this.status(),
      p = target(j);
    if (!("Allocated" in p.phase)) throw Error("ExplicitCancelRequired");
    const source = await this.verifySource(j, archive, sourceSecret);
    source.rootRaw.fill(0);
    const kek = await this.deriveTarget(j),
      t = await transformArchive(
        archive,
        sourceSecret,
        cryptoGeneration(p.target),
        kek,
        j.current_live[0] ? cryptoGeneration(j.current_live[0]) : undefined,
      );
    let kit: Uint8Array | undefined,
      selectedKit: Uint8Array | undefined,
      selected: Uint8Array | undefined;
    const detach = this.session.addLockCleanup(() => {
      t.rootRaw.fill(0);
      t.recoverySecret.fill(0);
      kit?.fill(0);
      selectedKit?.fill(0);
    });
    try {
      this.session.check(ticket);
      await this.signed().send({
        RestoreStage: {
          normal: unpack(t.header.normal!),
          recovery: unpack(t.header.recovery),
          recovery_verifier: unb64(t.header.recovery_verifier!),
        },
      });
      this.session.check(ticket);
      const staged = await this.status();
      if (!sameRestoreGeneration(target(staged).target, p.target))
        throw Error("TargetChanged");
      kit = encodeIncidentKit(p.target, t.recoverySecret);
      await saveKit(kit);
      this.session.check(ticket);
      selectedKit = await reselectKit();
      this.session.check(ticket);
      const raw = await verifyIncidentKit(kitTarget(staged), kek, selectedKit);
      try {
        this.session.check(ticket);
        if (!equal(raw, t.rootRaw)) throw Error("RootMismatch");
      } finally {
        raw.fill(0);
      }
      await savePrepared(t.archive);
      this.session.check(ticket);
      selected = await reselectPrepared();
      this.session.check(ticket);
      const reopened = await openArchive(selected, t.recoverySecret);
      try {
        this.session.check(ticket);
        if (
          !equal(reopened.restoreRoot, t.targetRestoreRoot) ||
          JSON.stringify(reopened.header) !== JSON.stringify(t.header)
        )
          throw Error("PreparedArchiveMismatch");
      } finally {
        reopened.rootRaw.fill(0);
      }
      const f = restorePreflight(
        j,
        t.records,
        t.targetRestoreRoot,
        BigInt(t.header.sequence),
      );
      await this.signed().send({
        RestoreConfirmKit: { envelope_digest: target(staged).envelope_digest },
      });
      this.session.check(ticket);
      await this.signed().send({ RestorePreflight: f });
      this.session.check(ticket);
      return selected;
    } finally {
      detach();
      t.rootRaw.fill(0);
      t.recoverySecret.fill(0);
      kit?.fill(0);
      selectedKit?.fill(0);
    }
  }
  async discard() {
    const ticket = this.session.capture(),
      j = await this.status(),
      p = target(j),
      current = j.current_live[0];
    if (!current) throw Error("NoLiveCollision");
    await this.signed().send({
      RestoreDiscard: { current, cursor: p.cleanup_cursor },
    });
    this.session.check(ticket);
    return this.status();
  }
  async cancel() {
    const ticket = this.session.capture(),
      j = await this.status();
    await this.signed().send({
      RestoreCancel: { cursor: j.pipeline[0]?.cleanup_cursor ?? 0n },
    });
    this.session.check(ticket);
    return this.status();
  }
  /** Resume only from explicitly saved ciphertext; never recreate randomized wrappers. */
  async resumePrepared(
    sourceArchive: Uint8Array,
    oldSecret: Uint8Array,
    preparedArchive: Uint8Array,
    newKit: Uint8Array,
  ) {
    return this.processPrepared(
      sourceArchive,
      oldSecret,
      preparedArchive,
      newKit,
      true,
    );
  }
  async importPrepared(
    sourceArchive: Uint8Array,
    oldSecret: Uint8Array,
    preparedArchive: Uint8Array,
    newKit: Uint8Array,
  ) {
    return this.processPrepared(
      sourceArchive,
      oldSecret,
      preparedArchive,
      newKit,
      false,
    );
  }
  private async processPrepared(
    sourceArchive: Uint8Array,
    oldSecret: Uint8Array,
    preparedArchive: Uint8Array,
    newKit: Uint8Array,
    resumeOnly: boolean,
  ) {
    const ticket = this.session.capture(),
      j = await this.status(),
      p = target(j),
      f = p.preflight[0];
    if (
      !(
        "EnvelopesStaged" in p.phase ||
        "KitConfirmed" in p.phase ||
        "Importing" in p.phase ||
        "BackupVerified" in p.phase
      )
    )
      throw Error("PreparedResumeUnavailable");
    const source = await this.verifySource(j, sourceArchive, oldSecret);
    let secret: Uint8Array;
    try {
      secret = kitSecret(newKit, p.target);
    } catch (e) {
      source.rootRaw.fill(0);
      throw e;
    }
    let prepared: Awaited<ReturnType<typeof openArchive>> | undefined;
    const detach = this.session.addLockCleanup(() => {
      source.rootRaw.fill(0);
      secret.fill(0);
      prepared?.rootRaw.fill(0);
    });
    try {
      prepared = await openArchive(preparedArchive, secret);
      this.session.check(ticket);
      const kek = await this.deriveTarget(j),
        raw = await verifyIncidentKit(kitTarget(j), kek, newKit);
      try {
        this.session.check(ticket);
        if (!equal(raw, prepared.rootRaw)) throw Error("RootMismatch");
      } finally {
        raw.fill(0);
      }
      if (
        (f && !equal(prepared.restoreRoot, f.target_commitment)) ||
        prepared.header.generation?.nonce !== b64(bytes(p.target.nonce)) ||
        prepared.records.length !== source.records.length
      )
        throw Error("PreparedArchiveMismatch");
      const cg = cryptoGeneration(p.target);
      const previousEpoch =
        j.current_live[0] &&
        j.current_live[0].epoch > BigInt(source.header.epoch)
          ? j.current_live[0].epoch
          : BigInt(source.header.epoch);
      if (
        !p.normal[0] ||
        !p.recovery[0] ||
        cg.epoch !== previousEpoch + 1n ||
        source.header.generation?.nonce === b64(cg.nonce)
      )
        throw Error("TargetChanged");
      const wireEnvelope = (e: NonNullable<(typeof p.normal)[0]>) =>
        pack({ ...e, nonce: bytes(e.nonce), ciphertext: bytes(e.ciphertext) });
      const expectedHeader = {
        ...source.header,
        version: 2,
        envelope_revision: "0",
        epoch: cg.epoch.toString(),
        key_name: cg.key_name,
        generation: {
          ...cg,
          vault: b64(cg.vault),
          nonce: b64(cg.nonce),
          epoch: cg.epoch.toString(),
        },
        normal: wireEnvelope(p.normal[0]),
        recovery: wireEnvelope(p.recovery[0]),
        recovery_verifier: b64(bytes(p.recovery_verifier)),
      };
      if (canonical(prepared.header) !== canonical(expectedHeader))
        throw Error("PreparedArchiveMismatch");
      for (let i = 0; i < source.records.length; i++) {
        const a = source.records[i],
          b = prepared.records[i];
        if (
          JSON.stringify({ ...a, manifest: "" }) !==
          JSON.stringify({ ...b, manifest: "" })
        )
          throw Error("SourceChanged");
        if (
          source.chunks[i].length !== prepared.chunks[i].length ||
          source.chunks[i].some(
            (chunk, index) => !equal(chunk, prepared!.chunks[i][index]),
          )
        )
          throw Error("SourceChanged");
        if (!a.deleted) {
          const x = strictJSON(
              new TextDecoder().decode(unb64(a.manifest)),
            ) as Record<string, unknown>,
            y = strictJSON(
              new TextDecoder().decode(unb64(b.manifest)),
            ) as Record<string, unknown>;
          if (
            JSON.stringify(x.metadata) !== JSON.stringify(y.metadata) ||
            JSON.stringify(x.nonces) !== JSON.stringify(y.nonces)
          )
            throw Error("SourceChanged");
        }
      }
      const preflight = restorePreflight(
        j,
        prepared.records,
        prepared.restoreRoot,
        BigInt(prepared.header.sequence),
      );
      if (f && canonical(f) !== canonical(preflight))
        throw Error("PreparedArchiveMismatch");
      if (resumeOnly) {
        if ("EnvelopesStaged" in p.phase) {
          await this.signed().send({
            RestoreConfirmKit: { envelope_digest: p.envelope_digest },
          });
          this.session.check(ticket);
        }
        if (!f) {
          await this.signed().send({ RestorePreflight: preflight });
          this.session.check(ticket);
        }
        return this.status();
      }
      if (!f) throw Error("MissingPreflight");
      if ("KitConfirmed" in p.phase) {
        await this.signed().send({ RestoreBeginImport: null });
        this.session.check(ticket);
      }
      const progress = ok(
        await this.actor.restore_target_progress(j.request.job, p.target),
      );
      this.session.check(ticket);
      for (let i = Number(progress.count); i < prepared.records.length; i++) {
        const r = restoreRevision(prepared.records[i]);
        await this.signed().send({ RestoreRecord: r });
        this.session.check(ticket);
        for (let index = 0; index < prepared.chunks[i].length; index++) {
          await this.signed().send({
            RestoreChunk: { index, data: prepared.chunks[i][index] },
          });
          this.session.check(ticket);
        }
        await this.signed().send({
          RestoreCommitRecord: { sequence: r.sequence },
        });
        this.session.check(ticket);
      }
      return this.status();
    } finally {
      detach();
      source.rootRaw.fill(0);
      secret.fill(0);
      prepared?.rootRaw.fill(0);
    }
  }
  async saveAndVerifyBackup(newKit: Uint8Array, save: Save, reselect: Select) {
    const ticket = this.session.capture(),
      j = await this.status(),
      p = target(j),
      secret = kitSecret(newKit, p.target);
    let raw: Uint8Array | undefined;
    const detach = this.session.addLockCleanup(() => {
      secret.fill(0);
      raw?.fill(0);
    });
    try {
      const kek = await this.deriveTarget(j);
      raw = await verifyIncidentKit(kitTarget(j), kek, newKit);
      this.session.check(ticket);
      const d = ok(
        await this.actor.restore_target_descriptor(j.request.job, p.target),
      );
      this.session.check(ticket);
      if (
        !d.export.header.generation[0] ||
        !sameRestoreGeneration(d.export.header.generation[0], p.target)
      )
        throw Error("TargetChanged");
      const records: PortableRecord[] = [];
      let after = 0n;
      for (;;) {
        const page = ok(
          await this.actor.restore_target_index(j.request.job, p.target, after),
        );
        this.session.check(ticket);
        records.push(...page.entries.map(portableRecord));
        if (records.length > 10000) throw Error("SizeLimit");
        if (!page.next[0]) break;
        if (page.next[0] <= after) throw Error("InvalidCursor");
        after = page.next[0];
      }
      const commitment = await targetRestoreRoot(
        cryptoGeneration(p.target),
        records,
      );
      this.session.check(ticket);
      if (!equal(commitment, d.commitment))
        throw Error("ServerContentMismatch");
      const header = portableExport(d.export),
        archive = await makeArchive(
          header,
          records,
          async (r, index) => {
            const c = bytes(
              ok(
                await this.actor.restore_target_chunk(
                  j.request.job,
                  p.target,
                  unb64(r.object),
                  BigInt(r.revision),
                  index,
                ),
              ),
            );
            this.session.check(ticket);
            return c;
          },
          raw,
        );
      this.session.check(ticket);
      await save(archive);
      this.session.check(ticket);
      const selected = await reselect();
      this.session.check(ticket);
      const verified = await openArchive(selected, secret);
      try {
        this.session.check(ticket);
        if (
          canonical(verified.header) !== canonical(header) ||
          !equal(verified.restoreRoot, d.commitment) ||
          !equal(verified.rootRaw, raw)
        )
          throw Error("BackupMismatch");
        const archive_hash = await hash(selected);
        this.session.check(ticket);
        await this.signed().send({
          RestoreConfirmBackup: {
            descriptor_digest: d.descriptor_digest,
            commitment: d.commitment,
            archive_hash,
            archive_length: BigInt(selected.length),
            recovery_verifier: p.recovery_verifier,
            sequence: d.export.sequence,
          },
        });
        this.session.check(ticket);
      } finally {
        verified.rootRaw.fill(0);
      }
      return this.status();
    } finally {
      detach();
      secret.fill(0);
      raw?.fill(0);
    }
  }
  async activate() {
    const ticket = this.session.capture();
    await this.signed().send({ RestoreActivate: null });
    this.session.check(ticket);
    this.signer?.destroy();
    this.signer = undefined;
    this.reuse = undefined;
    this.proofContext = undefined;
    return this.status();
  }
  async retry() {
    return this.signed().retry();
  }
}
