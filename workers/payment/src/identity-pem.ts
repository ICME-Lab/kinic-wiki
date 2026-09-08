// Where: workers/payment/src/identity-pem.ts
// What: Worker identity loading from icp-cli secp256k1 PEM exports.
// Why: The IAP authority is stored as a Worker secret PEM.

import type { Secp256k1KeyIdentity } from "@icp-sdk/core/identity/secp256k1";

const EC_PRIVATE_KEY_HEADER = "-----BEGIN EC PRIVATE KEY-----";
const PKCS8_PRIVATE_KEY_HEADER = "-----BEGIN PRIVATE KEY-----";
const SECP256K1_OID_DER = Uint8Array.from([0x06, 0x05, 0x2b, 0x81, 0x04, 0x00, 0x0a]);

type DerNode = {
  tag: number;
  valueStart: number;
  valueEnd: number;
  nextOffset: number;
};

export async function identityFromPem(identityPem: string): Promise<Secp256k1KeyIdentity> {
  const { Secp256k1KeyIdentity } = await import("@icp-sdk/core/identity/secp256k1");
  const trimmed = identityPem.trim();
  if (trimmed.startsWith(EC_PRIVATE_KEY_HEADER)) {
    return Secp256k1KeyIdentity.fromPem(trimmed);
  }
  if (!trimmed.startsWith(PKCS8_PRIVATE_KEY_HEADER)) {
    throw new Error("identity PEM must be a secp256k1 private key");
  }
  return Secp256k1KeyIdentity.fromSecretKey(secretKeyFromPkcs8Pem(trimmed));
}

function secretKeyFromPkcs8Pem(identityPem: string): Uint8Array {
  const der = pemToDer(identityPem, PKCS8_PRIVATE_KEY_HEADER, "-----END PRIVATE KEY-----");
  const root = readDerNode(der, 0);
  if (root.tag !== 0x30 || root.nextOffset !== der.length) {
    throw new Error("PKCS#8 identity PEM is not a DER sequence");
  }
  const rootChildren = readDerChildren(der, root);
  const algorithm = rootChildren[1];
  const privateKey = rootChildren[2];
  if (!algorithm || algorithm.tag !== 0x30 || !containsBytes(der, algorithm, SECP256K1_OID_DER)) {
    throw new Error("PKCS#8 identity PEM must use secp256k1");
  }
  if (!privateKey || privateKey.tag !== 0x04) {
    throw new Error("PKCS#8 identity PEM is missing private key bytes");
  }
  const ecPrivateKey = readDerNode(der, privateKey.valueStart);
  if (ecPrivateKey.tag !== 0x30 || ecPrivateKey.nextOffset !== privateKey.valueEnd) {
    throw new Error("PKCS#8 identity PEM does not contain an EC private key");
  }
  const ecChildren = readDerChildren(der, ecPrivateKey);
  const secret = ecChildren.find((node) => node.tag === 0x04 && node.valueEnd - node.valueStart === 32);
  if (!secret) {
    throw new Error("PKCS#8 identity PEM does not contain a 32-byte secp256k1 secret");
  }
  return der.slice(secret.valueStart, secret.valueEnd);
}

function pemToDer(pem: string, header: string, footer: string): Uint8Array {
  const lines = pem.trim().split(/\r?\n/u);
  if (lines[0]?.trim() !== header || lines.at(-1)?.trim() !== footer) {
    throw new Error("invalid identity PEM envelope");
  }
  const binary = atob(lines.slice(1, -1).join(""));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function readDerNode(bytes: Uint8Array, offset: number): DerNode {
  if (offset + 2 > bytes.length) throw new Error("truncated DER node");
  const tag = bytes[offset];
  const lengthStart = offset + 1;
  const firstLength = bytes[lengthStart];
  if (firstLength === undefined) throw new Error("truncated DER length");
  if ((firstLength & 0x80) === 0) {
    return derNode(bytes, tag, lengthStart + 1, firstLength);
  }
  const lengthBytes = firstLength & 0x7f;
  if (lengthBytes === 0 || lengthBytes > 4 || lengthStart + lengthBytes >= bytes.length) {
    throw new Error("unsupported DER length");
  }
  let length = 0;
  for (let index = 0; index < lengthBytes; index += 1) {
    length = (length << 8) | bytes[lengthStart + 1 + index];
  }
  return derNode(bytes, tag, lengthStart + 1 + lengthBytes, length);
}

function derNode(bytes: Uint8Array, tag: number, valueStart: number, length: number): DerNode {
  const valueEnd = valueStart + length;
  if (valueEnd > bytes.length) throw new Error("DER node length exceeds input");
  return { tag, valueStart, valueEnd, nextOffset: valueEnd };
}

function readDerChildren(bytes: Uint8Array, parent: DerNode): DerNode[] {
  const children: DerNode[] = [];
  let offset = parent.valueStart;
  while (offset < parent.valueEnd) {
    const child = readDerNode(bytes, offset);
    if (child.nextOffset > parent.valueEnd) throw new Error("DER child exceeds parent");
    children.push(child);
    offset = child.nextOffset;
  }
  return children;
}

function containsBytes(bytes: Uint8Array, node: DerNode, needle: Uint8Array): boolean {
  for (let offset = node.valueStart; offset <= node.valueEnd - needle.length; offset += 1) {
    if (needle.every((value, index) => bytes[offset + index] === value)) return true;
  }
  return false;
}
