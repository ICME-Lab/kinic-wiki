// Where: workers/payment/src/app-store.ts
// What: App Store Server API transaction verification.
// Why: StoreKit JWS from the device is not trusted until Apple confirms it.

import type { AppStoreEnvironment, RuntimeEnv } from "./env.js";
import { base64Url, base64UrlJson, decodeJwsPayload } from "./jws.js";
import type { ProductCatalog } from "./product-catalog.js";

export type VerifiedTransaction = {
  transactionId: string;
  originalTransactionId: string;
  productId: string;
  bundleId: string;
  environment: AppStoreEnvironment;
  appAccountToken: string;
  cycles: bigint;
};

type TransactionPayload = {
  transactionId?: unknown;
  originalTransactionId?: unknown;
  productId?: unknown;
  bundleId?: unknown;
  environment?: unknown;
  appAccountToken?: unknown;
  revocationDate?: unknown;
};

type AppStoreTransactionResponse = {
  signedTransactionInfo?: unknown;
};

export async function verifyStoreKitTransaction(
  env: RuntimeEnv,
  transactionJWS: string,
  catalog: ProductCatalog,
  fetcher: typeof fetch = fetch
): Promise<VerifiedTransaction> {
  const devicePayload = transactionPayload(transactionJWS);
  const transactionId = requireText(devicePayload.transactionId, "transactionId");
  const serverJwt = await appStoreServerJwt(env);
  const response = await fetcher(`${appStoreBaseUrl(env.APP_STORE_ENVIRONMENT)}/inApps/v1/transactions/${encodeURIComponent(transactionId)}`, {
    headers: { authorization: `Bearer ${serverJwt}` }
  });
  if (!response.ok) {
    throw new Error(`App Store transaction lookup failed: ${response.status}`);
  }
  const body = (await response.json()) as AppStoreTransactionResponse;
  if (typeof body.signedTransactionInfo !== "string") {
    throw new Error("App Store response missing signedTransactionInfo");
  }
  const payload = transactionPayload(body.signedTransactionInfo);
  const verifiedTransactionId = requireText(payload.transactionId, "transactionId");
  if (verifiedTransactionId !== transactionId) {
    throw new Error("App Store transaction id mismatch");
  }
  const productId = requireText(payload.productId, "productId");
  const bundleId = requireText(payload.bundleId, "bundleId");
  const environment = requireEnvironment(payload.environment);
  const appAccountToken = requireUuidText(payload.appAccountToken, "appAccountToken");
  if (bundleId !== env.APP_STORE_BUNDLE_ID) {
    throw new Error("App Store bundle id mismatch");
  }
  if (environment !== env.APP_STORE_ENVIRONMENT) {
    throw new Error("App Store environment mismatch");
  }
  if (payload.revocationDate !== undefined && payload.revocationDate !== null) {
    throw new Error("App Store transaction was revoked");
  }
  const cycles = catalog.get(productId);
  if (!cycles) {
    throw new Error(`unknown IAP product: ${productId}`);
  }
  return {
    transactionId,
    originalTransactionId: requireText(payload.originalTransactionId, "originalTransactionId"),
    productId,
    bundleId,
    environment,
    appAccountToken,
    cycles
  };
}

export function transactionPayload(jws: string): TransactionPayload {
  const payload = decodeJwsPayload(jws);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("transaction payload must be an object");
  }
  return payload as TransactionPayload;
}

async function appStoreServerJwt(env: RuntimeEnv): Promise<string> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const header = base64UrlJson({ alg: "ES256", kid: env.APP_STORE_KEY_ID, typ: "JWT" });
  const payload = base64UrlJson({
    iss: env.APP_STORE_ISSUER_ID,
    iat: issuedAt,
    exp: issuedAt + 300,
    aud: "appstoreconnect-v1",
    bid: env.APP_STORE_BUNDLE_ID
  });
  const data = new TextEncoder().encode(`${header}.${payload}`);
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(env.APP_STORE_PRIVATE_KEY_PEM, "-----BEGIN PRIVATE KEY-----", "-----END PRIVATE KEY-----"),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, data));
  return `${header}.${payload}.${base64Url(signature)}`;
}

function appStoreBaseUrl(environment: AppStoreEnvironment): string {
  return environment === "Production" ? "https://api.storekit.itunes.apple.com" : "https://api.storekit-sandbox.itunes.apple.com";
}

function requireEnvironment(value: unknown): AppStoreEnvironment {
  if (value === "Production" || value === "Sandbox") return value;
  throw new Error("transaction environment is invalid");
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`transaction ${field} is required`);
  }
  return value;
}

function requireUuidText(value: unknown, field: string): string {
  const text = requireText(value, field);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(text)) {
    throw new Error(`transaction ${field} is invalid`);
  }
  return text.toLowerCase();
}

function pemToDer(pem: string, header: string, footer: string): Uint8Array {
  const lines = pem.trim().split(/\r?\n/u);
  if (lines[0]?.trim() !== header || lines.at(-1)?.trim() !== footer) {
    throw new Error("invalid App Store private key PEM envelope");
  }
  const binary = atob(lines.slice(1, -1).join(""));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
