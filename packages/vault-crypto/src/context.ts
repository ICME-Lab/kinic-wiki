import { Principal } from "@icp-sdk/core/principal";
import { EncryptedVetKey, type TransportSecretKey } from "@icp-sdk/vetkeys";
import { anchoredMaster, concat, importKey, u64, utf8 } from "./index.ts";

/** Immutable key-binding inputs. Copy untrusted byte arrays before storing. */
export type VaultContext = {
  canister: string;
  owner: string;
  vault: Uint8Array;
  nonce: Uint8Array;
  key_name: string;
};
const sized = (bytes: Uint8Array) => {
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, bytes.length);
  return concat(length, bytes);
};
export function copyVaultContext(c: VaultContext): VaultContext {
  const canister = Principal.fromText(c.canister);
  const owner = Principal.fromText(c.owner);
  if (
    canister.isAnonymous() ||
    owner.isAnonymous() ||
    !canister.toUint8Array().length ||
    !owner.toUint8Array().length ||
    c.vault.length !== 16 ||
    c.nonce.length !== 32 ||
    !c.key_name ||
    utf8.encode(c.key_name).length > 64
  )
    throw Error("InvalidContext");
  return {
    canister: canister.toText(),
    owner: owner.toText(),
    vault: new Uint8Array(c.vault),
    nonce: new Uint8Array(c.nonce),
    key_name: c.key_name,
  };
}
export function contextInput(context: VaultContext): Uint8Array {
  const c = copyVaultContext(context);
  return concat(
    ...[
      Principal.fromText(c.canister).toUint8Array(),
      Principal.fromText(c.owner).toUint8Array(),
      c.vault,
      c.nonce,
      utf8.encode(c.key_name),
    ].map(sized),
  );
}
export function documentAAD(
  context: VaultContext,
  object: Uint8Array,
  revision: bigint,
  usage: "dek" | "metadata" | "chunk",
  index = 0,
): Uint8Array {
  if (
    object.length !== 16 ||
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index > 0xffffffff
  )
    throw Error("InvalidInput");
  const idx = new Uint8Array(4);
  new DataView(idx.buffer).setUint32(0, index);
  return concat(
    ...[
      utf8.encode("kinic-vault/document/v3"),
      contextInput(context),
      object,
      u64(revision),
      utf8.encode(usage),
      idx,
    ].map(sized),
  );
}
const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((v, i) => v === b[i]);
/** Verify both the certified header and reply against the independently anchored key. */
export async function verifiedRoot(
  context: VaultContext,
  headerPublicKey: Uint8Array,
  reply: {
    input: Uint8Array;
    public_key: Uint8Array;
    encrypted_key: Uint8Array;
  },
  transport: TransportSecretKey,
  local: boolean,
): Promise<CryptoKey> {
  const c = copyVaultContext(context);
  const input = contextInput(c);
  const pk = anchoredMaster(c.key_name, local)
    .deriveCanisterKey(Principal.fromText(c.canister).toUint8Array())
    .deriveSubKey(utf8.encode("kinic-vault/ii-only/v1"));
  if (
    !equal(input, reply.input) ||
    !equal(pk.publicKeyBytes(), headerPublicKey) ||
    !equal(headerPublicKey, reply.public_key)
  )
    throw Error("InvalidKeyContext");
  const key = EncryptedVetKey.deserialize(reply.encrypted_key).decryptAndVerify(
    transport,
    pk,
    input,
  );
  const raw = key.deriveSymmetricKey("kinic-vault/root/v3", 32);
  try {
    return await importKey(raw);
  } finally {
    raw.fill(0);
  }
}
