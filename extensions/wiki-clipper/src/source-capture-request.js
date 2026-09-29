// Where: extensions/wiki-clipper/src/source-capture-request.js
// What: Normalize extension input URLs and expose fixed runtime defaults.
// Why: Active-tab capture and settings need stable canister defaults and URL validation.

import { RUNTIME_CANISTER_ID, RUNTIME_IC_HOST } from "./runtime-config.js";

export const DEFAULT_CANISTER_ID = RUNTIME_CANISTER_ID;
export const DEFAULT_IC_HOST = RUNTIME_IC_HOST;
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
  if (!url.hash.startsWith("#/") && !url.hash.startsWith("#!/")) {
    url.hash = "";
  }
  return url.toString();
}
