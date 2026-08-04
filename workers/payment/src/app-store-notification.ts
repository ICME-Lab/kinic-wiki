// Where: workers/payment/src/app-store-notification.ts
// What: App Store Server Notification V2 JWS verification.
// Why: Refund/revoke audit rows must only contain Apple-signed payloads.

import { verify as verifySignature, X509Certificate } from "node:crypto";
import type { RuntimeEnv } from "./env.js";
import { decodeJwsHeader, decodeJwsPayload, jwsSignature, jwsSigningInput } from "./jws.js";

export type VerifiedAppStoreNotification = {
  notificationUUID: string;
  notificationType: string;
  subtype: string | null;
  transactionId: string | null;
  signedPayload: string;
};

type NotificationPayload = {
  notificationUUID?: unknown;
  notificationType?: unknown;
  subtype?: unknown;
  data?: unknown;
};

type NotificationData = {
  bundleId?: unknown;
  environment?: unknown;
  signedTransactionInfo?: unknown;
};

type JwsHeader = {
  alg?: unknown;
  x5c?: unknown;
};

export async function verifyAppStoreNotification(env: RuntimeEnv, signedPayload: string): Promise<VerifiedAppStoreNotification> {
  const payload = await verifyAppleSignedJws(env, signedPayload);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("notification payload must be an object");
  }
  const notification = payload as NotificationPayload;
  const data = notificationData(env, notification);
  return {
    notificationUUID: requiredText(notification.notificationUUID, "notificationUUID"),
    notificationType: requiredText(notification.notificationType, "notificationType"),
    subtype: typeof notification.subtype === "string" ? notification.subtype : null,
    transactionId: await notificationTransactionId(env, data),
    signedPayload
  };
}

async function notificationTransactionId(env: RuntimeEnv, data: NotificationData): Promise<string | null> {
  const signedTransactionInfo = data.signedTransactionInfo;
  if (typeof signedTransactionInfo !== "string") return null;
  const transaction = await verifyAppleSignedJws(env, signedTransactionInfo);
  if (!transaction || typeof transaction !== "object" || Array.isArray(transaction)) return null;
  validateAppStoreIdentity(env, transaction, "transaction");
  const transactionId = Reflect.get(transaction, "transactionId");
  return typeof transactionId === "string" ? transactionId : null;
}

async function verifyAppleSignedJws(env: RuntimeEnv, jws: string): Promise<unknown> {
  const certificates = certificatesFromHeader(jws);
  validateCertificateChain(env, certificates);
  const signatureOk = verifySignature(
    "sha256",
    Buffer.from(jwsSigningInput(jws)),
    { key: certificates[0].publicKey, dsaEncoding: "ieee-p1363" },
    Buffer.from(jwsSignature(jws))
  );
  if (!signatureOk) {
    throw new Error("App Store notification signature is invalid");
  }
  return decodeJwsPayload(jws);
}

function certificatesFromHeader(jws: string): X509Certificate[] {
  const header = decodeJwsHeader(jws);
  if (!header || typeof header !== "object" || Array.isArray(header)) {
    throw new Error("App Store notification JWS header must be an object");
  }
  const typed = header as JwsHeader;
  if (typed.alg !== "ES256") {
    throw new Error("App Store notification JWS alg must be ES256");
  }
  if (!Array.isArray(typed.x5c) || typed.x5c.length < 2 || typed.x5c.some((value) => typeof value !== "string")) {
    throw new Error("App Store notification JWS x5c chain is required");
  }
  return typed.x5c.map((value) => new X509Certificate(Buffer.from(String(value), "base64")));
}

function validateCertificateChain(env: RuntimeEnv, certificates: X509Certificate[]): void {
  const expectedRoot = env.APP_STORE_NOTIFICATION_ROOT_SHA256?.replaceAll(":", "").toLowerCase();
  if (!expectedRoot) {
    throw new Error("APP_STORE_NOTIFICATION_ROOT_SHA256 is not configured");
  }
  const now = Date.now();
  for (const certificate of certificates) {
    if (Date.parse(certificate.validFrom) > now || Date.parse(certificate.validTo) < now) {
      throw new Error("App Store notification certificate is expired or not yet valid");
    }
  }
  for (let index = 0; index < certificates.length - 1; index += 1) {
    const certificate = certificates[index];
    const issuer = certificates[index + 1];
    if (!certificate.checkIssued(issuer) || !certificate.verify(issuer.publicKey)) {
      throw new Error("App Store notification certificate chain is invalid");
    }
  }
  const root = certificates[certificates.length - 1];
  const rootFingerprint = root.fingerprint256.replaceAll(":", "").toLowerCase();
  if (rootFingerprint !== expectedRoot) {
    throw new Error("App Store notification root certificate fingerprint mismatch");
  }
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value;
}

function notificationData(env: RuntimeEnv, payload: NotificationPayload): NotificationData {
  if (!payload.data || typeof payload.data !== "object" || Array.isArray(payload.data)) {
    throw new Error("notification data must be an object");
  }
  validateAppStoreIdentity(env, payload.data, "notification");
  return payload.data as NotificationData;
}

function validateAppStoreIdentity(env: RuntimeEnv, value: object, label: string): void {
  const bundleId = requiredText(Reflect.get(value, "bundleId"), `${label} bundleId`);
  const environment = requiredText(Reflect.get(value, "environment"), `${label} environment`);
  if (bundleId !== env.APP_STORE_BUNDLE_ID) {
    throw new Error(`${label} bundle id mismatch`);
  }
  if (environment !== env.APP_STORE_ENVIRONMENT) {
    throw new Error(`${label} environment mismatch`);
  }
}
