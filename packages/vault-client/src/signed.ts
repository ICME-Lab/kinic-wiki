import { IDL } from "@icp-sdk/core/candid";
import { Principal } from "@icp-sdk/core/principal";
// Generated from the same Rust Mutation type as the server's strict decoder.
// @ts-ignore generated JS factory has an equivalent generated TS contract beside it.
import { idlFactory } from "../../vault-candid/mutation.js";
import type { Mutation, MutationOperation } from "./mutation-contracts.ts";
import type {
  GrantInfo,
  GrantPurpose,
  Generation,
  MutationResult,
  VaultActor,
} from "./contracts.ts";
import { concat, utf8 } from "../../vault-crypto/src/index.ts";
// @ts-ignore generated JS has the adjacent generated TS contract.
import { idlFactory as vaultIDL } from "../../vault-candid/index.js";
const grantRequestIDL = (vaultIDL({ IDL }) as IDL.ServiceClass)._fields.find(
  ([name]) => name === "begin_grant",
)![1].argTypes[0]!;
/** Canonical full wire binding; no secret or ephemeral key is retained here. */
export function grantBinding(
  credential: Uint8Array,
  purpose: GrantPurpose,
  generations: Generation[],
) {
  return new Uint8Array(
    IDL.encode(
      [grantRequestIDL],
      [
        {
          operation: new Uint8Array(16),
          public_key: new Uint8Array(32),
          credential,
          purpose,
          generations,
        },
      ],
    ),
  );
}
export function authorityContext(value: unknown): string {
  if (typeof value === "bigint") return `bigint:${value}`;
  if (value instanceof Principal) return `principal:${value.toText()}`;
  if (value instanceof Uint8Array) return authorityContext(Array.from(value));
  if (Array.isArray(value)) return `[${value.map(authorityContext).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${authorityContext(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export const MUTATION_DOMAIN = utf8.encode("kinic-vault/mutation/v2\0");
export const mutationIDL = (
  idlFactory({ IDL }) as IDL.ServiceClass
)._fields.find(([name]) => name === "encode")![1].argTypes[0]!;
export function encodeMutation(m: Mutation) {
  return new Uint8Array(IDL.encode([mutationIDL], [m]));
}
export async function ephemeralSigner() {
  const keys = (await crypto.subtle.generateKey("Ed25519", false, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  return {
    keys,
    publicKey: new Uint8Array(
      await crypto.subtle.exportKey("raw", keys.publicKey),
    ),
  };
}
/** One unresolved request per grant. A network error keeps EXACT bytes/signature for retry. */
export class SignedMutations {
  private pending?: { payload: Uint8Array; signature: Uint8Array };
  private flight?: Promise<MutationResult>;
  private key?: CryptoKey;
  private counter: bigint;
  private rejected = false;
  constructor(
    private actor: Pick<VaultActor, "mutate">,
    private owner: Principal,
    private canister: Principal,
    private grant: GrantInfo,
    keys: CryptoKeyPair,
  ) {
    this.key = keys.privateKey;
    this.counter = grant.next_counter;
  }
  get hasPending() {
    return !!this.pending || !!this.flight;
  }
  get reusable() {
    return (
      !!this.key &&
      !this.hasPending &&
      !this.rejected &&
      BigInt(Math.floor(Date.now() / 1000)) < this.grant.expires
    );
  }
  destroy() {
    this.key = undefined;
    this.pending?.payload.fill(0);
    this.pending?.signature.fill(0);
    this.pending = undefined;
  }
  async send(operation: MutationOperation) {
    if (this.pending || this.flight) throw Error("ResolvePendingMutation");
    if (
      !this.key ||
      BigInt(Math.floor(Date.now() / 1000)) >= this.grant.expires
    ) {
      this.destroy();
      throw Error("GrantExpired");
    }
    const key = this.key;
    const payload = encodeMutation({
      version: 2,
      owner: this.owner,
      canister: this.canister,
      grant: this.grant.id,
      counter: this.counter,
      operation,
    });
    // Reserve the one-flight slot before the asynchronous signer yields.
    const execute = async () => {
      const signature = new Uint8Array(
        await crypto.subtle.sign(
          "Ed25519",
          key,
          new Uint8Array(concat(MUTATION_DOMAIN, payload)).buffer,
        ),
      );
      if (this.key !== key) throw Error("Locked");
      this.pending = { payload, signature };
      return this.transmit();
    };
    this.flight = execute();
    try {
      return await this.flight;
    } finally {
      this.flight = undefined;
    }
  }
  async retry() {
    if (this.flight) return this.flight;
    if (!this.pending) throw Error("NoPendingMutation");
    this.flight = this.transmit();
    try {
      return await this.flight;
    } finally {
      this.flight = undefined;
    }
  }
  private async transmit() {
    const p = this.pending;
    if (!p || !this.key) throw Error("Locked");
    const result = await this.actor.mutate(p.payload, p.signature);
    if (!this.key || this.pending !== p) throw Error("Locked");
    if ("Err" in result) {
      this.pending = undefined;
      this.rejected = true;
      throw Error(Object.keys(result.Err)[0]);
    }
    this.counter++;
    this.pending = undefined;
    return result.Ok;
  }
}
