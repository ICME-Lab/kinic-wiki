/** Ordinary authority is ephemeral, owner-bound and never shared with Wiki. */
import { Principal } from "@icp-sdk/core/principal";
import type {
  VaultActor,
  Generation,
  GrantInfo,
  GrantPurpose,
  Header,
  UnfinishedVault,
  CleanupProgress,
} from "./contracts";
import type { MutationOperation, CleanupAction } from "./mutation-contracts";
import { Session } from "./session";
import { SignedMutations, ephemeralSigner } from "./signed";
import { assertCredential, register } from "./webauthn";
import {
  randomBytes,
  TransportSecretKey,
  verifiedGenerationKEK,
} from "../../vault-crypto/src/index";
import { bytes, ok } from "./api";
export const cryptoGeneration = (g: Generation) => ({
  ...g,
  version: 2 as const,
  canister: g.canister.toText(),
  owner: g.owner.toText(),
  vault: bytes(g.vault),
  nonce: bytes(g.nonce),
});
export class OrdinaryAuthority {
  private signer?: SignedMutations;
  private normal = false;
  private detachCleanup: () => void;
  credential?: Uint8Array;
  constructor(
    private actor: VaultActor,
    private owner: Principal,
    private canister: Principal,
    private rp: () => string,
    private local: boolean,
    private session: Session,
  ) {
    this.detachCleanup = session.addLockCleanup(() => this.clear());
  }
  destroy() {
    this.clear();
    this.detachCleanup();
  }
  clear() {
    this.signer?.destroy();
    this.signer = undefined;
    this.normal = false;
  }
  private install(grant: GrantInfo, keys: CryptoKeyPair) {
    this.signer?.destroy();
    this.signer = new SignedMutations(
      this.actor,
      this.owner,
      this.canister,
      grant,
      keys,
    );
    this.normal = "Normal" in grant.purpose;
  }
  async authorize(purpose: GrantPurpose, generations: Generation[]) {
    if (this.signer?.hasPending) throw Error("ResolvePendingMutation");
    const ticket = this.session.capture(),
      keys = await ephemeralSigner();
    this.session.check(ticket);
    const list = ok(await this.actor.list_credentials());
    this.session.check(ticket);
    const credential =
      this.credential ?? (list.length === 1 ? bytes(list[0].id) : undefined);
    if (!credential) throw Error("ChoosePasskey");
    const operation = randomBytes(16),
      cleanup = "Cleanup" in purpose || "CancelCreation" in purpose;
    const request = {
      operation,
      public_key: keys.publicKey,
      credential,
      purpose,
      generations,
    };
    const ch = ok(
      await (cleanup
        ? this.actor.begin_cleanup(request)
        : this.actor.begin_grant(request)),
    );
    this.session.check(ticket);
    const proof = await assertCredential(ch, this.rp(), this.session.signal);
    this.session.check(ticket);
    const grant = ok(
      await (cleanup
        ? this.actor.finish_cleanup(operation, proof)
        : this.actor.finish_grant(operation, proof)),
    );
    this.session.check(ticket);
    this.install(grant, keys.keys);
    return grant;
  }
  async bootstrap(vault: Uint8Array, attempt: Uint8Array) {
    const ticket = this.session.capture(),
      keys = await ephemeralSigner();
    this.session.check(ticket);
    const reply = ok(
      await this.actor.bootstrap({
        reserve: { vault, operation: attempt },
        public_key: keys.publicKey,
      }),
    );
    this.session.check(ticket);
    const proof = await register(
      reply.challenge,
      this.owner.toUint8Array(),
      this.rp(),
      this.session.signal,
    );
    this.session.check(ticket);
    const grant = ok(await this.actor.register_bootstrap(attempt, proof));
    this.session.check(ticket);
    this.install(grant, keys.keys);
    return reply.header;
  }
  async send(operation: MutationOperation) {
    const ticket = this.session.capture();
    if (!this.signer) throw Error("FreshProofRequired");
    if (this.signer.hasPending) throw Error("ResolvePendingMutation");
    let result;
    // Only transport rejection leaves a pending signature. Never re-sign an uncertain request.
    try {
      result = await this.signer.send(operation);
    } catch (e) {
      this.session.check(ticket);
      if (!this.signer.hasPending) throw e;
      for (let i = 0; ; i++) {
        this.session.check(ticket);
        try {
          result = await this.signer.retry();
          break;
        } catch (error) {
          if (!this.signer?.hasPending || i >= 1) throw error;
        }
      }
    }
    this.session.check(ticket);
    return result;
  }
  async normalSend(operation: MutationOperation, generation: Generation) {
    if (!this.normal) await this.authorize({ Normal: null }, [generation]);
    return this.send(operation);
  }
  async retry() {
    if (!this.signer) throw Error("FreshProofRequired");
    const ticket = this.session.capture(),
      r = await this.signer.retry();
    this.session.check(ticket);
    return r;
  }
  async derive(header: Header, attempt?: Uint8Array) {
    const ticket = this.session.capture(),
      g = header.generation[0];
    if (!g) throw Error("LegacyRecoveryRequired");
    if (
      g.owner.toText() !== this.owner.toText() ||
      g.canister.toText() !== this.canister.toText()
    )
      throw Error("WrongNamespace");
    const transport = TransportSecretKey.random();
    this.session.transport = transport;
    try {
      const h = await this.send({
        Derive: {
          vault: header.id,
          epoch: header.epoch,
          transport: transport.publicKeyBytes(),
          assertion: [],
          attempt: attempt ? [attempt] : [],
        },
      });
      if (!("Handle" in h)) throw Error("MissingKeyHandle");
      const result = await this.send({ KeyResult: { handle: h.Handle } });
      if (!("Key" in result)) throw Error("MissingKeyResult");
      const kek = await verifiedGenerationKEK(
        bytes(result.Key.encrypted_key),
        transport,
        cryptoGeneration(g),
        this.local,
      );
      this.session.check(ticket);
      return kek;
    } finally {
      if (this.session.transport === transport)
        this.session.transport = undefined;
    }
  }
  async cleanup(
    action: CleanupAction,
    headers: Header[],
    pending?: UnfinishedVault,
    progress?: (value: CleanupProgress) => void,
  ) {
    const ticket = this.session.capture(),
      status = ok(await this.actor.cleanup_status())[0];
    this.session.check(ticket);
    const job =
        status && !status.complete ? bytes(status.job) : randomBytes(16),
      startingCursor = status && !status.complete ? status.cursor : 0n;
    const generations = headers.map((h) => {
      if (!h.generation[0]) throw Error("LegacyRecoveryRequired");
      return h.generation[0];
    });
    if (pending) {
      if (!pending.namespace[0]) throw Error("CleanupUnavailable");
      await this.authorize(
        {
          CancelCreation: {
            job,
            target: {
              namespace: pending.namespace[0],
              vault: pending.vault,
              attempt: pending.attempt,
            },
          },
        },
        [],
      );
    } else await this.authorize({ Cleanup: { job } }, generations);
    let cursor = startingCursor;
    for (;;) {
      this.session.check(ticket);
      const result = await this.send({ Cleanup: { job, cursor, action } });
      if (!("Cleanup" in result) || result.Cleanup.cursor <= cursor)
        throw Error("MissingCleanupProgress");
      this.session.check(ticket);
      progress?.(result.Cleanup);
      if (result.Cleanup.complete) return result.Cleanup;
      cursor = result.Cleanup.cursor;
    }
  }
}
