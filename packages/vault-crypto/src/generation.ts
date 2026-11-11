/** Portable v2 generation encoding, shared with vault_types::Generation. */
import { Principal } from "@icp-sdk/core/principal";
import {
  concat,
  utf8,
  u64,
  seal,
  open,
  importKey,
  anchoredMaster,
  TransportSecretKey,
  type Envelope,
} from "./index.ts";
import { EncryptedVetKey } from "@icp-sdk/vetkeys";
export type Generation = {
  version: 2;
  canister: string;
  owner: string;
  vault: Uint8Array;
  epoch: bigint;
  nonce: Uint8Array;
  key_name: string;
};
const sized = (v: Uint8Array) => {
  const n = new Uint8Array(4);
  new DataView(n.buffer).setUint32(0, v.length);
  return concat(n, v);
};
export function generationBytes(g: Generation) {
  const canister = Principal.fromText(g.canister),
    owner = Principal.fromText(g.owner);
  if (
    g.version !== 2 ||
    g.vault.length !== 16 ||
    g.nonce.length !== 32 ||
    g.epoch < 0n ||
    g.epoch > 9223372036854775807n ||
    !g.key_name ||
    utf8.encode(g.key_name).length > 64 ||
    owner.isAnonymous() ||
    canister.isAnonymous() ||
    !owner.toUint8Array().length ||
    !canister.toUint8Array().length
  )
    throw Error("InvalidGeneration");
  return concat(
    sized(utf8.encode("kinic-vault/generation/v2")),
    new Uint8Array([2]),
    sized(canister.toUint8Array()),
    sized(owner.toUint8Array()),
    g.vault,
    u64(g.epoch),
    g.nonce,
    sized(utf8.encode(g.key_name)),
  );
}
export const generationKeyInput = (g: Generation) =>
  concat(utf8.encode("kinic-vault/key-input/v2"), generationBytes(g));
export function generationAAD(
  g: Generation,
  object: Uint8Array,
  revision: bigint,
  purpose: "normal" | "recovery" | "dek",
) {
  if (object.length !== 16) throw Error("InvalidInput");
  return concat(
    sized(utf8.encode("kinic-vault/envelope/v2")),
    sized(generationBytes(g)),
    sized(object),
    sized(u64(revision)),
    sized(utf8.encode(purpose)),
  );
}
export async function sealV2(
  key: CryptoKey,
  plain: Uint8Array,
  binding: Uint8Array,
): Promise<Envelope> {
  return { ...(await seal(key, plain, binding)), version: 2 };
}
export function openV2(key: CryptoKey, e: Envelope, binding: Uint8Array) {
  if (e.version !== 2) throw Error("InvalidEnvelope");
  return open(key, { ...e, version: 1 }, binding);
}
export function verifiedGenerationKEK(
  encrypted: Uint8Array,
  transport: TransportSecretKey,
  g: Generation,
  local: boolean,
) {
  const pk = anchoredMaster(g.key_name, local)
    .deriveCanisterKey(Principal.fromText(g.canister).toUint8Array())
    .deriveSubKey(utf8.encode("kinic-vault/kek/v2"));
  const key = EncryptedVetKey.deserialize(encrypted).decryptAndVerify(
    transport,
    pk,
    generationKeyInput(g),
  );
  return importKey(key.deriveSymmetricKey("kinic-vault/vrk-wrap/v2", 32));
}
export type PortableGeneration = Omit<
  Generation,
  "vault" | "nonce" | "epoch"
> & { vault: string; nonce: string; epoch: string };
