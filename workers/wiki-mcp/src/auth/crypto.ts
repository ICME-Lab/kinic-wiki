export type EncryptedValueV1 = {
  version: 1;
  algorithm: "AES-GCM";
  iv: string;
  ciphertext: string;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function randomOpaque(bytes = 32): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return base64UrlEncode(value);
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return base64UrlEncode(new Uint8Array(digest));
}

export async function secretEquals(expectedHash: string, candidate: string): Promise<boolean> {
  const actual = await sha256(candidate);
  const expectedBytes = encoder.encode(expectedHash);
  const actualBytes = encoder.encode(actual);
  if (expectedBytes.byteLength !== actualBytes.byteLength) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < expectedBytes.byteLength; index += 1) {
    difference |= expectedBytes[index] ^ actualBytes[index];
  }
  return difference === 0;
}

export async function encryptJson(value: unknown, keyText: string, context: string): Promise<EncryptedValueV1> {
  const key = await importEncryptionKey(keyText);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(context) },
    key,
    encoder.encode(JSON.stringify(value))
  );
  return {
    version: 1,
    algorithm: "AES-GCM",
    iv: base64UrlEncode(iv),
    ciphertext: base64UrlEncode(new Uint8Array(ciphertext))
  };
}

export async function decryptJson<T>(value: EncryptedValueV1, keyText: string, context: string): Promise<T> {
  if (value.version !== 1 || value.algorithm !== "AES-GCM") {
    throw new Error("unsupported encrypted value");
  }
  const key = await importEncryptionKey(keyText);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(base64UrlDecode(value.iv)),
      additionalData: encoder.encode(context)
    },
    key,
    toArrayBuffer(base64UrlDecode(value.ciphertext))
  );
  return JSON.parse(decoder.decode(plaintext)) as T;
}

export function base64UrlEncode(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

export function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/u.test(value)) {
    throw new Error("invalid base64url");
  }
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function decodeEncryptionKey(value: string): Uint8Array {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("MCP_KEY_ENCRYPTION_KEY is required");
  }
  let decoded: Uint8Array;
  try {
    decoded = base64UrlDecode(trimmed.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, ""));
  } catch {
    throw new Error("MCP_KEY_ENCRYPTION_KEY must be base64 or base64url");
  }
  if (decoded.byteLength !== 32) {
    throw new Error("MCP_KEY_ENCRYPTION_KEY must decode to 32 bytes");
  }
  return decoded;
}

async function importEncryptionKey(value: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", toArrayBuffer(decodeEncryptionKey(value)), "AES-GCM", false, ["encrypt", "decrypt"]);
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  return Uint8Array.from(value).buffer;
}
