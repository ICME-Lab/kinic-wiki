// Where: workers/payment/src/app-store-notification.ts
// What: App Store Server Notification V2 JWS verification.
// Why: Refund/revoke audit rows must only contain Apple-signed payloads.

import { verify as verifySignature, X509Certificate } from "node:crypto";
import { allowedAppStoreEnvironments, type AppStoreEnvironment, type RuntimeEnv } from "./env.js";
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

const APP_STORE_NOTIFICATION_LEAF_OID = "1.2.840.113635.100.6.11.1";
const APPLE_WORLDWIDE_DEVELOPER_RELATIONS_CA_OID = "1.2.840.113635.100.6.2.1";

export async function verifyAppStoreNotification(env: RuntimeEnv, signedPayload: string): Promise<VerifiedAppStoreNotification> {
  const payload = await verifyAppleSignedJws(env, signedPayload);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("notification payload must be an object");
  }
  const notification = payload as NotificationPayload;
  const data = notificationData(notification);
  const environment = validateAppStoreIdentity(env, data, "notification");
  return {
    notificationUUID: requiredText(notification.notificationUUID, "notificationUUID"),
    notificationType: requiredText(notification.notificationType, "notificationType"),
    subtype: typeof notification.subtype === "string" ? notification.subtype : null,
    transactionId: await notificationTransactionId(env, data, environment),
    signedPayload
  };
}

async function notificationTransactionId(env: RuntimeEnv, data: NotificationData, notificationEnvironment: AppStoreEnvironment): Promise<string | null> {
  const signedTransactionInfo = data.signedTransactionInfo;
  if (typeof signedTransactionInfo !== "string") return null;
  const transaction = await verifyAppleSignedJws(env, signedTransactionInfo);
  if (!transaction || typeof transaction !== "object" || Array.isArray(transaction)) return null;
  const transactionEnvironment = validateAppStoreIdentity(env, transaction, "transaction");
  if (transactionEnvironment !== notificationEnvironment) {
    throw new Error("transaction environment does not match notification environment");
  }
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
  if (!Array.isArray(typed.x5c) || typed.x5c.length !== 3 || typed.x5c.some((value) => typeof value !== "string")) {
    throw new Error("App Store notification JWS x5c chain is required");
  }
  return typed.x5c.map((value) => new X509Certificate(Buffer.from(String(value), "base64")));
}

function validateCertificateChain(env: RuntimeEnv, certificates: X509Certificate[]): void {
  const expectedRoots = new Set(
    env.APP_STORE_NOTIFICATION_ROOT_SHA256S
      .split(",")
      .map((fingerprint) => fingerprint.replaceAll(":", "").trim().toLowerCase())
      .filter(Boolean)
  );
  if (expectedRoots.size === 0 || [...expectedRoots].some((fingerprint) => !/^[0-9a-f]{64}$/u.test(fingerprint))) {
    throw new Error("APP_STORE_NOTIFICATION_ROOT_SHA256S is invalid");
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
  const leaf = certificates[0];
  const intermediate = certificates[1];
  if (!intermediate.ca) {
    throw new Error("App Store notification intermediate certificate must be a CA");
  }
  if (!hasCertificateExtension(leaf, APP_STORE_NOTIFICATION_LEAF_OID)) {
    throw new Error("App Store notification leaf certificate purpose is invalid");
  }
  if (!hasCertificateExtension(intermediate, APPLE_WORLDWIDE_DEVELOPER_RELATIONS_CA_OID)) {
    throw new Error("App Store notification intermediate certificate purpose is invalid");
  }
  const root = certificates[certificates.length - 1];
  const rootFingerprint = root.fingerprint256.replaceAll(":", "").toLowerCase();
  if (!expectedRoots.has(rootFingerprint)) {
    throw new Error("App Store notification root certificate fingerprint mismatch");
  }
}

function hasCertificateExtension(certificate: X509Certificate, oid: string): boolean {
  const certificateSequence = readDerElement(certificate.raw, 0);
  if (certificateSequence.tag !== 0x30 || certificateSequence.end !== certificate.raw.length) {
    throw new Error("App Store notification certificate DER is invalid");
  }
  const tbsCertificate = readDerElement(certificate.raw, certificateSequence.contentStart);
  if (tbsCertificate.tag !== 0x30) {
    throw new Error("App Store notification TBSCertificate is invalid");
  }
  let offset = tbsCertificate.contentStart;
  while (offset < tbsCertificate.end) {
    const element = readDerElement(certificate.raw, offset);
    if (element.tag === 0xa3) {
      return extensionSequenceContainsOid(certificate.raw, element, oid);
    }
    offset = element.end;
  }
  return false;
}

type DerElement = {
  tag: number;
  contentStart: number;
  end: number;
};

function extensionSequenceContainsOid(der: Uint8Array, wrapper: DerElement, expectedOid: string): boolean {
  const extensions = readDerElement(der, wrapper.contentStart);
  if (extensions.tag !== 0x30 || extensions.end !== wrapper.end) {
    throw new Error("App Store notification certificate extensions are invalid");
  }
  let offset = extensions.contentStart;
  while (offset < extensions.end) {
    const extension = readDerElement(der, offset);
    if (extension.tag !== 0x30) {
      throw new Error("App Store notification certificate extension is invalid");
    }
    const identifier = readDerElement(der, extension.contentStart);
    if (identifier.tag !== 0x06) {
      throw new Error("App Store notification certificate extension identifier is invalid");
    }
    if (decodeDerOid(der.subarray(identifier.contentStart, identifier.end)) === expectedOid) {
      return true;
    }
    offset = extension.end;
  }
  return false;
}

function readDerElement(der: Uint8Array, offset: number): DerElement {
  if (offset < 0 || offset + 2 > der.length) {
    throw new Error("App Store notification certificate DER is truncated");
  }
  const tag = der[offset];
  const firstLength = der[offset + 1];
  let contentStart = offset + 2;
  let length = firstLength;
  if ((firstLength & 0x80) !== 0) {
    const lengthBytes = firstLength & 0x7f;
    if (lengthBytes === 0 || lengthBytes > 4 || contentStart + lengthBytes > der.length) {
      throw new Error("App Store notification certificate DER length is invalid");
    }
    length = 0;
    for (let index = 0; index < lengthBytes; index += 1) {
      length = length * 256 + der[contentStart + index];
    }
    contentStart += lengthBytes;
  }
  const end = contentStart + length;
  if (!Number.isSafeInteger(end) || end > der.length) {
    throw new Error("App Store notification certificate DER is truncated");
  }
  return { tag, contentStart, end };
}

function decodeDerOid(bytes: Uint8Array): string {
  if (bytes.length === 0) {
    throw new Error("App Store notification certificate OID is empty");
  }
  const first = bytes[0];
  const firstArc = first < 40 ? 0 : first < 80 ? 1 : 2;
  const arcs = [String(firstArc), String(first - firstArc * 40)];
  let value = 0n;
  let continuation = false;
  for (const byte of bytes.subarray(1)) {
    value = (value << 7n) | BigInt(byte & 0x7f);
    continuation = (byte & 0x80) !== 0;
    if (!continuation) {
      arcs.push(value.toString());
      value = 0n;
    }
  }
  if (continuation) {
    throw new Error("App Store notification certificate OID is truncated");
  }
  return arcs.join(".");
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value;
}

function notificationData(payload: NotificationPayload): NotificationData {
  if (!payload.data || typeof payload.data !== "object" || Array.isArray(payload.data)) {
    throw new Error("notification data must be an object");
  }
  return payload.data as NotificationData;
}

function validateAppStoreIdentity(env: RuntimeEnv, value: object, label: string): AppStoreEnvironment {
  const bundleId = requiredText(Reflect.get(value, "bundleId"), `${label} bundleId`);
  const environment = requiredText(Reflect.get(value, "environment"), `${label} environment`);
  if (bundleId !== env.APP_STORE_BUNDLE_ID) {
    throw new Error(`${label} bundle id mismatch`);
  }
  if (environment !== "Production" && environment !== "Sandbox") {
    throw new Error(`${label} environment is invalid`);
  }
  if (!allowedAppStoreEnvironments(env).has(environment)) {
    throw new Error(`${label} environment is not allowed`);
  }
  return environment;
}
