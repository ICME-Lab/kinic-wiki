// Where: extensions/wiki-clipper/src/source-capture-request.js
// What: Normalize extension input URLs and expose fixed runtime defaults.
// Why: Active-tab capture and settings need stable canister defaults and URL validation.

export const DEFAULT_CANISTER_ID = "6emaw-iyaaa-aaaay-aacka-cai";
export const DEFAULT_IC_HOST = "https://icp0.io";
export const SOURCE_CAPTURE_STATUS_KEY = "kinic-source-capture-status-v1";

export function normalizedHttpUrl(value) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    throw new Error("Enter a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("URL must use http or https.");
  }
  url.hash = "";
  return url.toString();
}
