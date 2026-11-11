import {
  EncryptedVetKey,
  MasterPublicKey,
  MasterPublicKeyId,
  PocketIcMasterPublicKeyId,
  TransportSecretKey,
} from "@icp-sdk/vetkeys";
import { Principal } from "@icp-sdk/core/principal";
export type Envelope = {
  version: number;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
};
export const utf8 = new TextEncoder();
export const randomBytes = (n: number) => {
  if (!Number.isSafeInteger(n) || n < 0 || n > 10485776)
    throw Error("InvalidInput");
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536)
    crypto.getRandomValues(out.subarray(i, Math.min(n, i + 65536)));
  return out;
};
const buf = (b: Uint8Array): ArrayBuffer => new Uint8Array(b).buffer;
export const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
};
export function u64(n: bigint) {
  if (n < 0n || n >= 1n << 64n) throw Error("InvalidInput");
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n);
  return b;
}
const id = (b: Uint8Array) => {
  if (b.length !== 16) throw Error("InvalidInput");
  return b;
};
const sized = (b: Uint8Array) => {
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, b.length);
  return concat(len, b);
};
export function keyInput(v: Uint8Array, e: bigint) {
  return concat(id(v), u64(e));
}
// Wiki normal envelopes bind the vetKey derivation to the authenticated owner.
export function ownerKeyInput(
  owner: Uint8Array,
  vault: Uint8Array,
  epoch: bigint,
) {
  if (owner.length > 29) throw Error("InvalidInput");
  return concat(
    utf8.encode("kinic-wiki/private-vault/v1"),
    new Uint8Array([owner.length]),
    owner,
    id(vault),
    u64(epoch),
  );
}
export type Usage =
  | "normal"
  | "recovery"
  | "dek"
  | "metadata"
  | "chunk"
  | "archive";
export function aad(
  vault: Uint8Array,
  object: Uint8Array,
  revision: bigint,
  usage: Usage,
  index = 0,
) {
  if (!Number.isSafeInteger(index) || index < 0 || index > 0xffffffff)
    throw Error("InvalidInput");
  const idx = new Uint8Array(4);
  new DataView(idx.buffer).setUint32(0, index);
  return concat(
    sized(utf8.encode("kinic-vault/envelope/v1")),
    sized(id(vault)),
    sized(id(object)),
    sized(u64(revision)),
    sized(utf8.encode(usage)),
    sized(idx),
  );
}
export async function importKey(raw: Uint8Array) {
  if (raw.length !== 32) throw Error("InvalidInput");
  return crypto.subtle.importKey("raw", buf(raw), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}
export async function seal(
  key: CryptoKey,
  plain: Uint8Array,
  binding: Uint8Array,
): Promise<Envelope> {
  const nonce = randomBytes(12);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: buf(nonce),
        additionalData: buf(binding),
        tagLength: 128,
      },
      key,
      buf(plain),
    ),
  );
  return { version: 1, nonce, ciphertext };
}
export async function open(key: CryptoKey, e: Envelope, binding: Uint8Array) {
  if (e.version !== 1 || e.nonce.length !== 12 || e.ciphertext.length < 16)
    throw Error("InvalidEnvelope");
  return new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: buf(e.nonce),
        additionalData: buf(binding),
        tagLength: 128,
      },
      key,
      buf(e.ciphertext),
    ),
  );
}
export async function deriveKey(
  secret: Uint8Array,
  purpose: "recovery" | "archive",
) {
  if (secret.length !== 32) throw Error("InvalidInput");
  const k = await crypto.subtle.importKey("raw", buf(secret), "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(32),
      info: buf(utf8.encode(`kinic-vault/${purpose}/v1`)),
    },
    k,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
export function anchoredMaster(keyName: string, local: boolean) {
  if (keyName !== "test_key_1" && keyName !== "key_1")
    throw Error("UnsupportedKey");
  return local
    ? MasterPublicKey.pocketicKey(
        keyName === "key_1"
          ? PocketIcMasterPublicKeyId.KEY_1
          : PocketIcMasterPublicKeyId.TEST_KEY_1,
      )
    : MasterPublicKey.productionKey(
        keyName === "key_1"
          ? MasterPublicKeyId.KEY_1
          : MasterPublicKeyId.TEST_KEY_1,
      );
}
export function verifiedKEK(
  encrypted: Uint8Array,
  transport: TransportSecretKey,
  canister: string,
  vault: Uint8Array,
  epoch: bigint,
  local: boolean,
  owner?: Uint8Array,
  keyName = local ? "test_key_1" : "key_1",
) {
  const master = anchoredMaster(keyName, local);
  const pk = master
    .deriveCanisterKey(Principal.fromText(canister).toUint8Array())
    .deriveSubKey(utf8.encode("kinic-vault/kek/v1"));
  const vetkey = EncryptedVetKey.deserialize(encrypted).decryptAndVerify(
    transport,
    pk,
    owner ? ownerKeyInput(owner, vault, epoch) : keyInput(vault, epoch),
  );
  return importKey(vetkey.deriveSymmetricKey("kinic-vault/vrk-wrap/v1", 32));
}
export { TransportSecretKey };

export * from "./generation.ts";
export * from "./recovery.ts";
