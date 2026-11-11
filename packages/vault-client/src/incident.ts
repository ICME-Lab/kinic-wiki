/** Incident preparation and completion. Every resumed session uses fresh WebAuthn and separate role derives. */
import { wrapNext, saveAndVerify } from "./incident-backup";
import { Principal } from "@icp-sdk/core/principal";
import type {
  VaultActor,
  Generation,
  GrantPurpose,
  IncidentStatus,
  IncidentTarget,
} from "./contracts";
import type { IncidentRole } from "./mutation-contracts";
import { Session } from "./session";
import { SignedMutations, ephemeralSigner } from "./signed";
import { assertCredential } from "./webauthn";
import { bytes, ok } from "./api";
import { b64, unb64 } from "../../vault-crypto/src/documents";
import { strictJSON } from "../../vault-crypto/src/strict-json";
import {
  randomBytes,
  importKey,
  deriveKey,
  sealV2,
  openV2,
  generationAAD,
  generationBytes,
  recoveryVerifier,
  verifiedGenerationKEK,
  TransportSecretKey,
  utf8,
} from "../../vault-crypto/src/index";
const zero = new Uint8Array(16);
const equal = (a: Uint8Array | number[], b: Uint8Array | number[]) =>
  b64(bytes(a)) === b64(bytes(b));
export const cryptoGeneration = (g: Generation) => ({
  ...g,
  version: 2 as const,
  canister: g.canister.toText(),
  owner: g.owner.toText(),
  vault: bytes(g.vault),
  nonce: bytes(g.nonce),
});
const envelope = (e: NonNullable<IncidentTarget["normal"][0]>) => ({
  ...e,
  nonce: bytes(e.nonce),
  ciphertext: bytes(e.ciphertext),
});
export function encodeIncidentKit(g: Generation, secret: Uint8Array) {
  if (secret.length !== 32) throw Error("InvalidKit");
  return utf8.encode(
    JSON.stringify({
      version: 2,
      generation: b64(generationBytes(cryptoGeneration(g))),
      secret: b64(secret),
    }),
  );
}
/** Returns a temporary raw root for immediate import; caller must wipe it in finally. */
export async function verifyIncidentKit(
  t: IncidentTarget,
  kek: CryptoKey,
  data: Uint8Array,
) {
  if (data.length > 4096 || !t.target[0] || !t.normal[0] || !t.recovery[0])
    throw Error("InvalidKit");
  const kit = strictJSON(
    new TextDecoder("utf-8", { fatal: true }).decode(data),
  ) as Record<string, unknown>;
  const g = cryptoGeneration(t.target[0]);
  if (
    !kit ||
    Object.keys(kit).sort().join(",") !== "generation,secret,version" ||
    kit.version !== 2 ||
    kit.generation !== b64(generationBytes(g)) ||
    typeof kit.secret !== "string"
  )
    throw Error("InvalidKit");
  const secret = unb64(kit.secret);
  let normal: Uint8Array | undefined, recovery: Uint8Array | undefined;
  try {
    if (!equal(await recoveryVerifier(secret), t.recovery_verifier))
      throw Error("VerifierMismatch");
    normal = await openV2(
      kek,
      envelope(t.normal[0]),
      generationAAD(g, zero, 0n, "normal"),
    );
    recovery = await openV2(
      await deriveKey(secret, "recovery"),
      envelope(t.recovery[0]),
      generationAAD(g, zero, 0n, "recovery"),
    );
    if (normal.length !== 32 || !equal(normal, recovery))
      throw Error("RootMismatch");
    return normal.slice();
  } finally {
    secret.fill(0);
    normal?.fill(0);
    recovery?.fill(0);
  }
}
export class IncidentClient {
  private signer?: SignedMutations;
  private roots?: { source: CryptoKey; target: CryptoKey; binding: string };
  constructor(
    private actor: VaultActor,
    private owner: Principal,
    private canister: Principal,
    private rpId: string,
    private local: boolean,
    readonly session = new Session(),
  ) {
    session.addLockCleanup(() => {
      this.signer?.destroy();
      this.signer = undefined;
      this.roots = undefined;
    });
  }
  async authenticate(
    credential: Uint8Array,
    purpose: GrantPurpose,
    generations: Generation[],
  ) {
    const ticket = this.session.capture(),
      keys = await ephemeralSigner();
    this.session.check(ticket);
    const operation = randomBytes(16);
    const cleanup = "Cleanup" in purpose;
    const challenge = ok(
      await (cleanup ? this.actor.begin_cleanup : this.actor.begin_grant)({
        operation,
        public_key: keys.publicKey,
        credential,
        purpose,
        generations,
      }),
    );
    this.session.check(ticket);
    const proof = await assertCredential(
      challenge,
      this.rpId,
      this.session.signal,
    );
    this.session.check(ticket);
    const grant = ok(
      await (cleanup ? this.actor.finish_cleanup : this.actor.finish_grant)(
        operation,
        proof,
      ),
    );
    this.session.check(ticket);
    this.signer?.destroy();
    this.signer = new SignedMutations(
      this.actor,
      this.owner,
      this.canister,
      grant,
      keys.keys,
    );
    return grant;
  }
  async status(): Promise<IncidentStatus> {
    const j = ok(await this.actor.incident_status())[0];
    if (!j) throw Error("NoIncident");
    return j;
  }
  private signed() {
    if (!this.signer) throw Error("FreshIncidentProofRequired");
    return this.signer;
  }
  async retry() {
    return this.signed().retry();
  }
  /** One bounded cleanup call under a freshly authenticated Normal grant. */
  async clearInactive(vault: Uint8Array) {
    const result = await this.signed().send({ ClearInactive: { vault } });
    if (!("InactiveCleanup" in result)) throw Error("MissingCleanupProgress");
    return result.InactiveCleanup.complete;
  }
  async start() {
    return this.signed().send({ IncidentStart: null });
  }
  async allocate(vault: Uint8Array, attempt: Uint8Array) {
    return this.signed().send({ IncidentAllocate: { vault, attempt } });
  }
  async reset(vault: Uint8Array, attempt: Uint8Array) {
    this.roots = undefined;
    const ticket = this.session.capture(),
      j = await this.status();
    this.session.check(ticket);
    const t = j.targets.find(
      (t) => equal(t.source.id, vault) && equal(t.attempt, attempt),
    );
    if (!t) throw Error("TargetChanged");
    return this.signed().send({
      IncidentReset: {
        vault,
        attempt,
        next_attempt: t.reset_attempt[0] ?? randomBytes(16),
      },
    });
  }
  /** One bounded discard batch. Keep the same cleanup job ID when status is incomplete.
   * Lock first so outstanding preparation replies cannot publish roots or acknowledge a kit.
   * Fresh cleanup proof works at zero balance and cannot allocate or derive a key.
   */
  async cancel(credential: Uint8Array, job: Uint8Array) {
    this.session.lock();
    const ticket = this.session.capture();
    try {
      const j = await this.status();
      this.session.check(ticket);
      const generations = j.targets
        .filter((t) => !("Purging" in t.phase) && !("Purged" in t.phase))
        .map((t) => t.source.generation[0]!);
      await this.authenticate(credential, { Cleanup: { job } }, generations);
      this.session.check(ticket);
      const progress = ok(await this.actor.cleanup_status())[0];
      this.session.check(ticket);
      if (progress && !equal(progress.job, job) && !progress.complete)
        throw Error("OtherCleanupPending");
      if (progress && equal(progress.job, job) && progress.complete) {
        if (
          !j.cancel_digest[0] ||
          j.targets.some(
            (t) =>
              !("Cancelled" in t.phase) &&
              !("Purging" in t.phase) &&
              !("Purged" in t.phase),
          )
        )
          throw Error("CleanupJobAlreadyUsed");
        return progress;
      }
      const result = await this.signed().send({
        Cleanup: {
          job,
          cursor: progress && equal(progress.job, job) ? progress.cursor : 0n,
          action: {
            CancelIncident: {
              incident: j.job,
              vector_digest: j.cancel_digest[0] ?? j.vector_digest,
            },
          },
        },
      });
      this.session.check(ticket);
      if (!("Cleanup" in result)) throw Error("MissingCleanupProgress");
      return result.Cleanup;
    } finally {
      this.session.lock();
    }
  }
  private target(j: IncidentStatus, vault: Uint8Array) {
    const t = j.targets.find((t) => equal(t.source.id, vault));
    if (!t?.target[0]) throw Error("TargetNotAllocated");
    return t;
  }
  private async kek(j: IncidentStatus, t: IncidentTarget, role: IncidentRole) {
    const ticket = this.session.capture();
    const generation = ("Source" in role ? t.source.generation : t.target)[0];
    if (!generation) throw Error("MissingGeneration");
    if (
      generation.owner.toText() !== this.owner.toText() ||
      generation.canister.toText() !== this.canister.toText()
    )
      throw Error("WrongNamespace");
    const transport = TransportSecretKey.random();
    const result = await this.signed().send({
      IncidentDerive: {
        job: j.job,
        attempt: t.attempt,
        role,
        generation,
        transport: transport.publicKeyBytes(),
      },
    });
    this.session.check(ticket);
    if (!("Handle" in result)) throw Error("MissingKeyHandle");
    const reply = await this.signed().send({
      KeyResult: { handle: result.Handle },
    });
    this.session.check(ticket);
    if (!("Key" in reply)) throw Error("MissingKeyResult");
    const key = await verifiedGenerationKEK(
      bytes(reply.Key.encrypted_key),
      transport,
      cryptoGeneration(generation),
      this.local,
    );
    this.session.check(ticket);
    return key;
  }
  /** save must complete a download; reselect must read the separately selected NEW kit file. */
  async prepare(
    vault: Uint8Array,
    save: (file: Uint8Array) => Promise<void>,
    reselect: () => Promise<Uint8Array>,
  ) {
    const ticket = this.session.capture(),
      j = await this.status();
    this.session.check(ticket);
    const t = this.target(j, vault);
    if (!("Allocated" in t.phase)) throw Error("ExplicitResetRequired");
    const kek = await this.kek(j, t, { Target: null });
    this.session.check(ticket);
    const g = t.target[0]!,
      raw = randomBytes(32),
      secret = randomBytes(32);
    let file: Uint8Array | undefined,
      selected: Uint8Array | undefined,
      opened: Uint8Array | undefined;
    const detach = this.session.addLockCleanup(() => {
      raw.fill(0);
      secret.fill(0);
      file?.fill(0);
      selected?.fill(0);
      opened?.fill(0);
    });
    try {
      const normal = await sealV2(
        kek,
        raw,
        generationAAD(cryptoGeneration(g), zero, 0n, "normal"),
      );
      this.session.check(ticket);
      const recovery = await sealV2(
        await deriveKey(secret, "recovery"),
        raw,
        generationAAD(cryptoGeneration(g), zero, 0n, "recovery"),
      );
      this.session.check(ticket);
      const verifier = await recoveryVerifier(secret);
      this.session.check(ticket);
      await this.signed().send({
        IncidentStage: {
          vault,
          attempt: t.attempt,
          normal,
          recovery,
          recovery_verifier: verifier,
        },
      });
      this.session.check(ticket);
      const readback = await this.status();
      this.session.check(ticket);
      const staged = this.target(readback, vault);
      if (
        !equal(readback.vector_digest, j.vector_digest) ||
        !equal(staged.attempt, t.attempt)
      )
        throw Error("TargetChanged");
      file = encodeIncidentKit(g, secret);
      opened = await verifyIncidentKit(staged, kek, file);
      this.session.check(ticket);
      if (!equal(raw, opened)) throw Error("RootMismatch");
      opened.fill(0);
      opened = undefined;
      await save(file.slice());
      this.session.check(ticket);
      selected = await reselect();
      this.session.check(ticket);
      opened = await verifyIncidentKit(staged, kek, selected);
      this.session.check(ticket);
      if (!equal(raw, opened)) throw Error("RootMismatch");
      await this.signed().send({
        IncidentConfirmKit: {
          vault,
          attempt: t.attempt,
          envelope_digest: staged.envelope_digest,
        },
      });
      this.session.check(ticket);
    } finally {
      detach();
      raw.fill(0);
      secret.fill(0);
      file?.fill(0);
      selected?.fill(0);
      opened?.fill(0);
    }
  }
  /** Target normal rederive restores the target root, never the recovery secret. */
  async resume(vault: Uint8Array, reselect: () => Promise<Uint8Array>) {
    const ticket = this.session.capture(),
      j = await this.status();
    this.session.check(ticket);
    const t = this.target(j, vault);
    if (
      !("KitConfirmed" in t.phase) &&
      !("EnvelopesStaged" in t.phase) &&
      !("Wrapping" in t.phase) &&
      !("BackupVerified" in t.phase)
    )
      throw Error("NewKitConfirmationRequired");
    const sourceKEK = await this.kek(j, t, { Source: null }),
      targetKEK = await this.kek(j, t, { Target: null });
    this.session.check(ticket);
    const g = t.source.generation[0],
      normal = t.source.normal[0];
    if (!g || !normal) throw Error("MissingSourceEnvelope");
    let source: Uint8Array | undefined,
      target: Uint8Array | undefined,
      kit: Uint8Array | undefined;
    const detach = this.session.addLockCleanup(() => {
      source?.fill(0);
      target?.fill(0);
      kit?.fill(0);
    });
    try {
      source = await openV2(
        sourceKEK,
        envelope(normal),
        generationAAD(cryptoGeneration(g), zero, 0n, "normal"),
      );
      this.session.check(ticket);
      kit = await reselect();
      this.session.check(ticket);
      target = await verifyIncidentKit(t, targetKEK, kit);
      this.session.check(ticket);
      if ("EnvelopesStaged" in t.phase) {
        await this.signed().send({
          IncidentConfirmKit: {
            vault,
            attempt: t.attempt,
            envelope_digest: t.envelope_digest,
          },
        });
        this.session.check(ticket);
      }
      const roots = {
        binding: this.binding(j, t),
        source: await importKey(source),
        target: await importKey(target),
      };
      this.session.check(ticket);
      this.roots = roots;
    } finally {
      detach();
      source?.fill(0);
      target?.fill(0);
      kit?.fill(0);
    }
  }
  private binding(j: IncidentStatus, t: IncidentTarget) {
    return [
      b64(bytes(j.job)),
      b64(bytes(j.vector_digest)),
      b64(bytes(t.attempt)),
      b64(generationBytes(cryptoGeneration(t.target[0]!))),
    ].join(":");
  }
  async wrapNext(vault: Uint8Array) {
    const ticket = this.session.capture(),
      j = await this.status();
    this.session.check(ticket);
    const t = this.target(j, vault);
    if (!this.roots || this.roots.binding !== this.binding(j, t))
      throw Error("ResumeWithNewKitRequired");
    return wrapNext(this.actor, this.signed(), this.session, j, t, this.roots);
  }
  async saveBackup(
    vault: Uint8Array,
    save: (file: Uint8Array) => Promise<void>,
    reselectArchive: () => Promise<Uint8Array>,
    reselectKit: () => Promise<Uint8Array>,
  ) {
    const ticket = this.session.capture(),
      j = await this.status();
    this.session.check(ticket);
    const t = this.target(j, vault),
      kek = await this.kek(j, t, { Target: null });
    this.session.check(ticket);
    return saveAndVerify(
      this.actor,
      this.signed(),
      this.session,
      j,
      t,
      kek,
      save,
      reselectArchive,
      reselectKit,
    );
  }
  async cutover(credential: Uint8Array) {
    this.session.lock();
    const ticket = this.session.capture();
    try {
      const j = await this.status();
      this.session.check(ticket);
      if (j.complete) {
        if (!j.completed_digest[0]) throw Error("IncidentPurged");
        return j;
      }
      const digest = ok(await this.actor.incident_cutover_digest());
      this.session.check(ticket);
      const generations = j.targets
        .filter((t) => !("Purged" in t.phase))
        .map((t) => t.source.generation[0]!);
      await this.authenticate(
        credential,
        { IncidentCutover: { job: j.job, digest } },
        generations,
      );
      this.session.check(ticket);
      await this.signed().send({ IncidentCutover: { digest } });
      this.session.check(ticket);
      return await this.status();
    } finally {
      this.session.lock();
    }
  }
}
