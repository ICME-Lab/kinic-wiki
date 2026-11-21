// Where: extensions/vault-autofill/scripts/build.mjs
// What: Bundle the Kinic Vault MV3 service worker, offscreen engine, content autofill script, and popup.
// Why: Chrome MV3 cannot resolve workspace TypeScript or npm bare imports directly.
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const local = process.argv.includes("--local");
const outputRoot = local ? resolve(root, "tmp/local-unpacked") : root;
const dist = resolve(outputRoot, "dist");
const env = await readEnvFile(resolve(root, ".env"));

const PRODUCTION = {
  canisterId: "mcx4q-2qaaa-aaaao-qqn3a-cai",
  icHost: "https://icp0.io",
  derivationOrigin: "https://mcx4q-2qaaa-aaaao-qqn3a-cai.icp0.io",
  identityProvider: "https://id.ai",
  vaultWebOrigin: "https://vault.kinic.xyz",
  local: false
};

const target = local
  ? {
      canisterId: env.VAULT_LOCAL_CANISTER_ID || PRODUCTION.canisterId,
      icHost: env.VAULT_LOCAL_HOST || "http://127.0.0.1:4943",
      derivationOrigin:
        env.VAULT_LOCAL_DERIVATION_ORIGIN ||
        `http://${env.VAULT_LOCAL_CANISTER_ID || PRODUCTION.canisterId}.localhost:4943`,
      identityProvider: env.VAULT_LOCAL_II || "http://rdmx6-jaaaa-aaaaa-aaadq-cai.localhost:4943",
      vaultWebOrigin: env.VAULT_LOCAL_ORIGIN || "http://vault.localhost:3024",
      local: true
    }
  : PRODUCTION;

if (
  target.canisterId === "6emaw-iyaaa-aaaay-aacka-cai" ||
  target.derivationOrigin.includes("6emaw-iyaaa-aaaay-aacka-cai") ||
  target.vaultWebOrigin.includes("wiki.kinic.xyz")
) {
  throw new Error("Kinic Vault extension must never target a Kinic Wiki canister or origin.");
}

await rm(local ? outputRoot : dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

const sharedBuildOptions = {
  outdir: dist,
  bundle: true,
  platform: "browser",
  target: "chrome120",
  legalComments: "none",
  define: {
    __KINIC_VAULT_CANISTER_ID__: JSON.stringify(target.canisterId),
    __KINIC_VAULT_IC_HOST__: JSON.stringify(target.icHost),
    __KINIC_VAULT_DERIVATION_ORIGIN__: JSON.stringify(target.derivationOrigin),
    __KINIC_VAULT_IDENTITY_PROVIDER__: JSON.stringify(target.identityProvider),
    __KINIC_VAULT_WEB_ORIGIN__: JSON.stringify(target.vaultWebOrigin),
    __KINIC_VAULT_LOCAL__: JSON.stringify(target.local)
  }
};

// Service worker, offscreen document, auth tab, and popup run as ES modules.
await esbuild.build({
  ...sharedBuildOptions,
  entryPoints: {
    "service-worker": resolve(root, "src/service-worker.ts"),
    offscreen: resolve(root, "src/offscreen.ts"),
    popup: resolve(root, "popup/popup.ts"),
    "auth-login": resolve(root, "auth/login.ts")
  },
  format: "esm"
});

// Content scripts in MV3 manifest content_scripts execute as classic scripts (IIFE).
await esbuild.build({
  ...sharedBuildOptions,
  entryPoints: {
    "content-autofill": resolve(root, "src/content-autofill.ts")
  },
  format: "iife"
});

if (local) {
  await Promise.all([
    cp(resolve(root, "icons"), resolve(outputRoot, "icons"), { recursive: true }),
    cp(resolve(root, "offscreen"), resolve(outputRoot, "offscreen"), { recursive: true }),
    cp(resolve(root, "auth"), resolve(outputRoot, "auth"), {
      recursive: true,
      filter: (source) => !source.endsWith(".ts")
    }),
    cp(resolve(root, "popup"), resolve(outputRoot, "popup"), {
      recursive: true,
      filter: (source) => !source.endsWith(".ts")
    })
  ]);
  const manifest = JSON.parse(await readFile(resolve(root, "manifest.json"), "utf8"));
  manifest.name = "Kinic Vault (Local)";
  manifest.host_permissions = [
    `${new URL(target.icHost).origin}/*`,
    `${new URL(target.derivationOrigin).origin}/*`,
    `${new URL(target.identityProvider).origin}/*`,
    `${new URL(target.vaultWebOrigin).origin}/*`
  ];
  await writeFile(resolve(outputRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

console.log(
  local
    ? "built local Kinic Vault extension in tmp/local-unpacked"
    : "built dist/service-worker.js, dist/offscreen.js, dist/content-autofill.js, dist/popup.js, and dist/auth-login.js"
);

async function readEnvFile(path) {
  try {
    return parseEnv(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

function parseEnv(source) {
  const values = {};
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    values[key] = unquoteEnvValue(value);
  }
  return values;
}

function unquoteEnvValue(value) {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
