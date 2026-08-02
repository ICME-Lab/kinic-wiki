import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const androidAppLinkFingerprintVariable = "KINIC_ANDROID_APP_LINK_SHA256_CERT_FINGERPRINT";
const fingerprintPattern = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/;

export function normalizedAndroidAppLinkFingerprint(value) {
  const fingerprint = value?.trim().toUpperCase();
  if (!fingerprint || !fingerprintPattern.test(fingerprint)) {
    throw new Error(`${androidAppLinkFingerprintVariable} must be the Play App Signing SHA-256 fingerprint.`);
  }
  return fingerprint;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  normalizedAndroidAppLinkFingerprint(process.env[androidAppLinkFingerprintVariable]);
}
