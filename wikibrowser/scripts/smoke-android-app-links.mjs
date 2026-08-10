import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  androidAppLinkFingerprintVariable,
  normalizedAndroidAppLinkFingerprint
} from "./android-app-links-config.mjs";

export const androidPackageName = "xyz.kinic.android.kinicwiki";
export const androidAppLinksPath = "/.well-known/assetlinks.json";

export async function verifyPublishedAndroidAppLinks({
  baseUrl = "https://wiki.kinic.xyz",
  fingerprint,
  fetchImpl = fetch
}) {
  const expectedFingerprint = normalizedAndroidAppLinkFingerprint(fingerprint);
  const origin = validatedOrigin(baseUrl);
  const url = new URL(androidAppLinksPath, origin);
  const response = await fetchImpl(url, { redirect: "manual" });
  if (response.status >= 300 && response.status < 400) {
    throw new Error(`Android App Links endpoint must not redirect (HTTP ${response.status}).`);
  }
  if (response.status !== 200) {
    throw new Error(`Android App Links endpoint returned HTTP ${response.status}.`);
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new Error("Android App Links endpoint must return application/json.");
  }
  const statements = await response.json();
  if (!Array.isArray(statements)) {
    throw new Error("Android App Links response must be a JSON array.");
  }
  const statement = statements.find(
    (item) =>
      item?.target?.namespace === "android_app" &&
      item.target.package_name === androidPackageName &&
      Array.isArray(item.relation) &&
      item.relation.includes("delegate_permission/common.handle_all_urls")
  );
  if (!statement) {
    throw new Error(`Android App Links response does not authorize ${androidPackageName}.`);
  }
  if (!statement.target.sha256_cert_fingerprints?.includes(expectedFingerprint)) {
    throw new Error("Android App Links response does not contain the Play App Signing fingerprint.");
  }
  return url.toString();
}

function validatedOrigin(value) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("Android App Links base URL must be an HTTPS origin.");
  }
  return new URL(url.origin);
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const verifiedUrl = await verifyPublishedAndroidAppLinks({
    baseUrl: argumentValue("--base-url"),
    fingerprint: process.env[androidAppLinkFingerprintVariable]
  });
  console.log(`Verified Android App Links: ${verifiedUrl}`);
}
