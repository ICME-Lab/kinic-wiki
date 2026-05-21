// Where: extensions/wiki-clipper/scripts/release-check.mjs
// What: Validate Chrome Web Store release inputs before packaging.
// Why: Public review rejects broad permissions, missing icons, and incomplete listing disclosures.
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const requiredIconSizes = [16, 32, 48, 128];
const requiredStoreDocs = [
  "store-listing/listing.md",
  "store-listing/permissions.md",
  "store-listing/privacy-policy.md",
  "store-listing/review-notes.md",
  "store-listing/assets-checklist.md"
];
const requiredStoreImages = [
  { path: "store-listing/assets/promo-small-440x280.png", width: 440, height: 280 },
  { path: "store-listing/screenshots/options-1280x800.png", width: 1280, height: 800 },
  { path: "store-listing/screenshots/chatgpt-export-1280x800.png", width: 1280, height: 800 }
];

const errors = [];
const warnings = [];

const manifest = await readJson("manifest.json");
checkManifest(manifest);
await checkIcons(manifest);
await checkStoreDocs();
await checkStoreImages();

if (warnings.length) {
  for (const warning of warnings) console.warn(`warning: ${warning}`);
}
if (errors.length) {
  for (const error of errors) console.error(`error: ${error}`);
  process.exitCode = 1;
} else {
  console.log("Chrome Web Store release inputs OK");
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(resolve(root, path), "utf8"));
  } catch (error) {
    errors.push(`${path} is not readable JSON: ${message(error)}`);
    return {};
  }
}

function checkManifest(manifest) {
  const permissions = new Set(manifest.permissions || []);
  const hostPermissions = manifest.host_permissions || [];
  if (permissions.has("tabs")) errors.push("manifest permissions must not include tabs");
  for (const host of hostPermissions) {
    if (host.includes("localhost") || host.includes("127.0.0.1")) {
      errors.push(`manifest host permission is local-only: ${host}`);
    }
    if (host === "https://*.icp0.io/*") {
      errors.push("manifest host permission must not use the broad icp0.io wildcard");
    }
  }
  for (const size of requiredIconSizes) {
    const expected = `icons/icon-${size}.png`;
    if (manifest.icons?.[String(size)] !== expected) {
      errors.push(`manifest icons.${size} must be ${expected}`);
    }
    if (manifest.action?.default_icon?.[String(size)] !== expected) {
      errors.push(`manifest action.default_icon.${size} must be ${expected}`);
    }
  }
}

async function checkIcons(manifest) {
  for (const size of requiredIconSizes) {
    const path = manifest.icons?.[String(size)];
    if (!path) continue;
    const absolutePath = resolve(root, path);
    try {
      const buffer = await readFile(absolutePath);
      const shape = pngShape(buffer);
      if (shape.width !== size || shape.height !== size) {
        errors.push(`${path} must be ${size}x${size}, got ${shape.width}x${shape.height}`);
      }
    } catch (error) {
      errors.push(`${path} is missing or unreadable: ${message(error)}`);
    }
  }
}

async function checkStoreDocs() {
  for (const path of requiredStoreDocs) {
    try {
      await stat(resolve(root, path));
    } catch {
      errors.push(`${path} is required`);
    }
  }
  const privacyPolicy = await readTextIfExists("store-listing/privacy-policy.md");
  if (privacyPolicy.includes("<PRIVACY_POLICY_URL>")) {
    warnings.push("privacy policy URL placeholder remains: <PRIVACY_POLICY_URL>");
  }
}

async function checkStoreImages() {
  for (const image of requiredStoreImages) {
    try {
      const buffer = await readFile(resolve(root, image.path));
      const shape = pngShape(buffer);
      if (shape.width !== image.width || shape.height !== image.height) {
        errors.push(`${image.path} must be ${image.width}x${image.height}, got ${shape.width}x${shape.height}`);
      }
    } catch (error) {
      errors.push(`${image.path} is missing or unreadable: ${message(error)}`);
    }
  }
}

async function readTextIfExists(path) {
  try {
    return await readFile(resolve(root, path), "utf8");
  } catch {
    return "";
  }
}

function pngShape(buffer) {
  const signature = "89504e470d0a1a0a";
  if (buffer.subarray(0, 8).toString("hex") !== signature) {
    throw new Error("not a PNG");
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20)
  };
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}
