// Where: wikibrowser/lib/native-auth-payload.ts
// What: JSON-safe Internet Identity payload normalization for iOS native auth.
// Why: ICNativeClient expects delegation bytes as hex strings and expiration as decimal text.

export type NativeInternetIdentityResponse = {
  kind: "authorize-client-success";
  userPublicKey: string;
  delegations: NativeSignedDelegation[];
};

type NativeSignedDelegation = {
  delegation: {
    pubkey: string;
    expiration: string;
    targets?: string[];
  };
  signature: string;
};

export function normalizeInternetIdentityResponseForNative(value: unknown): NativeInternetIdentityResponse {
  const response = requiredRecord(value, "Internet Identity response");
  if (response.kind !== "authorize-client-success") {
    throw new Error("Internet Identity response kind is invalid");
  }
  const container = isRecord(response.delegation) ? response.delegation : response;
  const publicKey = bytesHex(container.userPublicKey ?? container.publicKey, "userPublicKey");
  const rawDelegations = container.delegations;
  if (!Array.isArray(rawDelegations) || rawDelegations.length === 0) {
    throw new Error("delegations are missing");
  }
  const delegations = rawDelegations.map((raw) => signedDelegation(raw));
  return {
    kind: "authorize-client-success",
    userPublicKey: publicKey,
    delegations
  };
}

function signedDelegation(value: unknown): NativeSignedDelegation {
  const record = requiredRecord(value, "signed delegation");
  const delegation = requiredRecord(record.delegation, "delegation");
  const normalized: NativeSignedDelegation["delegation"] = {
    pubkey: bytesHex(delegation.pubkey ?? delegation.publicKey, "delegation pubkey"),
    expiration: decimalString(delegation.expiration, "delegation expiration")
  };
  if (delegation.targets !== undefined) {
    if (!Array.isArray(delegation.targets)) {
      throw new Error("delegation targets are invalid");
    }
    normalized.targets = delegation.targets.map((target) => bytesHex(target, "delegation target"));
  }
  return {
    delegation: normalized,
    signature: bytesHex(record.signature, "delegation signature")
  };
}

function bytesHex(value: unknown, fieldName: string): string {
  if (typeof value === "string") {
    const trimmed = value.trim().replace(/^0x/i, "");
    if (trimmed.length > 0 && trimmed.length % 2 === 0 && /^[0-9a-f]+$/i.test(trimmed)) {
      return trimmed.toLowerCase();
    }
  }
  if (value instanceof Uint8Array) {
    return bytesToHex(Array.from(value));
  }
  if (value instanceof ArrayBuffer) {
    return bytesToHex(Array.from(new Uint8Array(value)));
  }
  if (Array.isArray(value)) {
    const bytes: number[] = [];
    for (const item of value) {
      if (!Number.isInteger(item) || item < 0 || item > 255) {
        throw new Error(`${fieldName} contains invalid byte`);
      }
      bytes.push(item);
    }
    return bytesToHex(bytes);
  }
  throw new Error(`${fieldName} is invalid`);
}

function decimalString(value: unknown, fieldName: string): string {
  if (typeof value === "bigint") {
    if (value < 0n) {
      throw new Error(`${fieldName} is invalid`);
    }
    return value.toString();
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^[0-9]+$/.test(trimmed)) {
      return trimmed;
    }
    if (/^0x[0-9a-f]+$/i.test(trimmed)) {
      return BigInt(trimmed).toString();
    }
  }
  throw new Error(`${fieldName} is invalid`);
}

function bytesToHex(bytes: number[]): string {
  return bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function requiredRecord(value: unknown, fieldName: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${fieldName} is invalid`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
