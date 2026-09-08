// Where: workers/payment/src/jws.ts
// What: Small JWS helpers for StoreKit and App Store Server API payloads.
// Why: The worker needs payload validation without adding a JWT dependency.

export function decodeJwsPayload(jws: string): unknown {
  return decodeJwsPart(jws, 1);
}

export function decodeJwsHeader(jws: string): unknown {
  return decodeJwsPart(jws, 0);
}

export function jwsSigningInput(jws: string): Uint8Array {
  const parts = jws.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new Error("invalid JWS compact serialization");
  }
  return new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
}

export function jwsSignature(jws: string): Uint8Array {
  const parts = jws.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new Error("invalid JWS compact serialization");
  }
  return bytesFromBase64Url(parts[2]);
}

export function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function base64UrlJson(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

export function bytesFromBase64Url(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function decodeJwsPart(jws: string, index: number): unknown {
  const parts = jws.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new Error("invalid JWS compact serialization");
  }
  return JSON.parse(textFromBase64Url(parts[index]));
}

function textFromBase64Url(value: string): string {
  const bytes = bytesFromBase64Url(value);
  return new TextDecoder().decode(bytes);
}
