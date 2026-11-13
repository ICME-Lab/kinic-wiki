import { grantProof } from "./grant-proof";
/** Explicit empty creation: fresh scoped UV, target-only keys, and a saved/reopened new kit. */
import type { Principal } from "@icp-sdk/core/principal";
import type {
  VaultActor,
  Generation,
  CreateEmptyStatus,
  PendingCreation,
} from "./contracts";
import { Session } from "./session";
import { SignedMutations, grantBinding, authorityContext } from "./signed";
import { bytes, ok } from "./wire";
import { cryptoGeneration, encodeIncidentKit, verifyIncidentKit } from "./incident";
import { b64 } from "../../vault-crypto/src/documents";
import {
  randomBytes,
  sealV2,
  deriveKey,
  generationAAD,
  generationBytes,
  recoveryVerifier,
  verifiedGenerationKEK,
  TransportSecretKey,
} from "../../vault-crypto/src/index";
const equal = (a: Uint8Array | number[], b: Uint8Array | number[]) =>
  b64(bytes(a)) === b64(bytes(b));
const kitTarget = (j: CreateEmptyStatus) => ({
  target: j.generation,
  normal: j.normal,
  recovery: j.recovery,
  recovery_verifier: j.recovery_verifier,
});
export class CreateEmptyClient {
  private signer?: SignedMutations;
  private reuse?: { binding: Uint8Array; context: string };
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
    });
  }
  destroy() {
    this.session.lock();
    this.signer?.destroy();
    this.signer = undefined;
    this.reuse = undefined;
    this.detach();
  }
  private signed() {
    if (!this.signer) throw Error("FreshScopedProofRequired");
    return this.signer;
  }
  async status() {
    const ticket = this.session.capture(),
      j = ok(await this.actor.create_empty_status())[0];
    this.session.check(ticket);
    if (!j) throw Error("NoEmptyCreation");
    return j;
  }
  /** Reuse the exact same purpose after reload/upgrade; the server rechecks the current source/key. */
  async authenticate(
    credential: Uint8Array,
    job: Uint8Array,
    target: PendingCreation,
    source: Generation,
  ) {
    if (this.signer?.hasPending) throw Error("ResolvePendingMutation");
    this.reuse = undefined;
    const ticket = this.session.capture();
    const purpose = { CreateEmpty: { job, target, authorizer_instance: source } };
    const { grant, keys } = await grantProof(
      this.session, this.rpId, { credential, purpose, generations: [source] },
      this.actor.begin_grant, this.actor.finish_grant,
      (ch) => {
        if (ch.registration || ch.credential_ids.length !== 1 || !equal(ch.credential_ids[0], credential))
          throw Error("CreatorChanged");
      },
    );
    this.session.check(ticket);
    this.signer?.destroy();
    this.signer = new SignedMutations(
      this.actor,
      this.owner,
      this.canister,
      grant,
      keys,
    );
    const current = await this.status();
    this.reuse = {
      binding: grantBinding(credential, purpose, [source]),
      context: this.authority(current),
    };
    return current;
  }
  private authority(j: CreateEmptyStatus) {
    return authorityContext([
      j.job,
      j.target,
      j.authorizer_instance,
      j.creator,
      j.generation,
      j.key_digest,
    ]);
  }
  async ensureAuthenticated(
    credential: Uint8Array,
    job: Uint8Array,
    target: PendingCreation,
    source: Generation,
  ) {
    if (this.signer?.hasPending) throw Error("ResolvePendingMutation");
    const current = await this.status();
    const purpose = {
      CreateEmpty: { job, target, authorizer_instance: source },
    };
    const binding = grantBinding(credential, purpose, [source]);
    if (
      this.signer?.reusable &&
      this.reuse &&
      equal(binding, this.reuse.binding) &&
      this.authority(current) === this.reuse.context
    )
      return current;
    return this.authenticate(credential, job, target, source);
  }
  async allocate() {
    const ticket = this.session.capture();
    const result = await this.signed().send({ CreateEmptyAllocate: null });
    this.session.check(ticket);
    if (!("Handle" in result)) throw Error("MissingAllocationHandle");
    await this.signed().send({ KeyResult: { handle: result.Handle } });
    this.session.check(ticket);
    return this.status();
  }
  private async derive(j: CreateEmptyStatus) {
    const ticket = this.session.capture(),
      g = j.generation[0];
    if (!g) throw Error("TargetNotAllocated");
    if (
      g.owner.toText() !== this.owner.toText() ||
      g.canister.toText() !== this.canister.toText() ||
      !equal(g.vault, j.target.vault)
    )
      throw Error("WrongNamespace");
    const transport = TransportSecretKey.random();
    const h = await this.signed().send({
      CreateEmptyDerive: {
        job: j.job,
        attempt: j.target.attempt,
        generation: g,
        role: { Target: null },
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
  async prepare(
    save: (file: Uint8Array) => Promise<void>,
    reselect: () => Promise<Uint8Array>,
  ) {
    const ticket = this.session.capture(),
      j = await this.status(),
      g = j.generation[0];
    if (!g || !("Allocated" in j.phase)) throw Error("ExplicitCancelRequired");
    const kek = await this.derive(j),
      raw = randomBytes(32),
      secret = randomBytes(32);
    let file: Uint8Array | undefined,
      selected: Uint8Array | undefined,
      reopened: Uint8Array | undefined;
    const detach = this.session.addLockCleanup(() => {
      raw.fill(0);
      secret.fill(0);
      file?.fill(0);
      selected?.fill(0);
      reopened?.fill(0);
    });
    try {
      const normal = await sealV2(
        kek,
        raw,
        generationAAD(cryptoGeneration(g), new Uint8Array(16), 0n, "normal"),
      );
      this.session.check(ticket);
      const recovery = await sealV2(
        await deriveKey(secret, "recovery"),
        raw,
        generationAAD(cryptoGeneration(g), new Uint8Array(16), 0n, "recovery"),
      );
      this.session.check(ticket);
      const recovery_verifier = await recoveryVerifier(secret);
      this.session.check(ticket);
      await this.signed().send({
        CreateEmptyStage: { normal, recovery, recovery_verifier },
      });
      this.session.check(ticket);
      const readback = await this.status(),
        target = readback.generation[0];
      if (
        !target ||
        !equal(readback.job, j.job) ||
        !equal(readback.target.attempt, j.target.attempt) ||
        !equal(
          generationBytes(cryptoGeneration(target)),
          generationBytes(cryptoGeneration(g)),
        )
      )
        throw Error("TargetChanged");
      file = encodeIncidentKit(g, secret);
      await save(file);
      this.session.check(ticket);
      selected = await reselect();
      this.session.check(ticket);
      reopened = await verifyIncidentKit(kitTarget(readback), kek, selected);
      this.session.check(ticket);
      if (!equal(reopened, raw)) throw Error("RootMismatch");
      await this.signed().send({
        CreateEmptyConfirmKit: { envelope_digest: readback.envelope_digest },
      });
      this.session.check(ticket);
      return this.status();
    } finally {
      detach();
      raw.fill(0);
      secret.fill(0);
      file?.fill(0);
      selected?.fill(0);
      reopened?.fill(0);
    }
  }
  /** A staged kit may be reselected after reload; it must open both stored envelopes. */
  async confirmSavedKit(file: Uint8Array) {
    const ticket = this.session.capture(),
      j = await this.status();
    if (!("EnvelopesStaged" in j.phase))
      throw Error("KitConfirmationUnavailable");
    const kek = await this.derive(j),
      raw = await verifyIncidentKit(kitTarget(j), kek, file);
    try {
      this.session.check(ticket);
      await this.signed().send({
        CreateEmptyConfirmKit: { envelope_digest: j.envelope_digest },
      });
      this.session.check(ticket);
      return this.status();
    } finally {
      raw.fill(0);
    }
  }
  async activate() {
    const ticket = this.session.capture();
    await this.signed().send({ CreateEmptyActivate: null });
    this.session.check(ticket);
    this.signer?.destroy();
    this.signer = undefined;
    this.reuse = undefined;
    return this.status();
  }
  async cancel() {
    const ticket = this.session.capture(),
      j = await this.status();
    const result = ok(
      await this.actor.cancel_create_empty(
        j.job,
        j.target,
        j.generation,
        j.cleanup_cursor,
      ),
    );
    this.session.check(ticket);
    this.signer?.destroy();
    this.signer = undefined;
    this.reuse = undefined;
    return result;
  }
  async retry() {
    return this.signed().retry();
  }
}
