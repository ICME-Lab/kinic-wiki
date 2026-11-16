import {
  MasterPublicKey,
  MasterPublicKeyId,
  PocketIcMasterPublicKeyId,
  TransportSecretKey,
} from "@icp-sdk/vetkeys";
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
  return { version: 3, nonce, ciphertext };
}
export async function open(key: CryptoKey, e: Envelope, binding: Uint8Array) {
  if (e.version !== 3 || e.nonce.length !== 12 || e.ciphertext.length < 16)
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
export { TransportSecretKey };
export * from "./context.ts";
