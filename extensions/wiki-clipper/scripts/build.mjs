// Where: extensions/wiki-clipper/scripts/build.mjs
// What: Bundle the MV3 service worker, content UI, and popup scripts.
// Why: Chrome cannot resolve npm bare imports or local .env files directly.
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const staging = process.argv.includes("--staging");
const outputRoot = staging ? resolve(root, "tmp/staging-unpacked") : root;
const dist = resolve(outputRoot, "dist");
const env = await readEnvFile(resolve(root, ".env"));

const production = {
  canisterId: "6emaw-iyaaa-aaaay-aacka-cai",
  derivationOrigin: "https://6emaw-iyaaa-aaaay-aacka-cai.icp0.io",
  triggerUrl: "https://wiki.kinic.xyz/api/source/run",
  wikiOrigin: "https://wiki.kinic.xyz"
};
const stagingConfig = {
  canisterId: "3ryrw-kyaaa-aaaaf-qgxpq-cai",
  derivationOrigin: "https://3ryrw-kyaaa-aaaaf-qgxpq-cai.icp0.io",
  triggerUrl: "https://kinic-wiki-browser-staging.hude.workers.dev/api/source/run",
  wikiOrigin: "https://kinic-wiki-browser-staging.hude.workers.dev",
  extensionKey: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqYOh1iSjPyS1d5x8Wxf9FDYikvUu/kR1aJP/tOetZSqly/Se0VdeGcaxMuVU1BxzT++sJXiCXqwZAvdZGj1biH13fBAR8KOuvCmhS3S/+QtlkmXARRm/DLy/VIaChRDPWrjK6a6DlSbrpiO8jzQSc8QA8WEm6Vy3m19boOVZKX2oPkx/HUfdD7XBLoLoAdTw46ka388l+zQCl/Nv17LnfqbCLTOcfVJRuzFOzvBvD8yawJvJx00+9BeX37ekOYQ4DMMpkpJGNLs7vaXCI6qB73sl1gGx4/yzn6pzk6xiAiE/Lso6w94yoCCvXIieiuzqJypIHcNlQPjELZ8KA1SB1wIDAQAB"
};
const target = staging ? stagingConfig : production;

await rm(staging ? outputRoot : dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await esbuild.build({
  entryPoints: {
    "service-worker": resolve(root, "src/service-worker.js"),
    "content-ui": resolve(root, "src/content-ui.tsx"),
    offscreen: resolve(root, "src/offscreen.js"),
    popup: resolve(root, "popup/popup.js")
  },
  outdir: dist,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "chrome120",
  minifySyntax: staging,
  jsx: "automatic",
  jsxImportSource: "preact",
  plugins: staging ? [runtimeConfigPlugin(target)] : [],
  define: {
    "process.env.KINIC_CAPTURE_DATABASE_ID": JSON.stringify(env.KINIC_CAPTURE_DATABASE_ID || ""),
    __KINIC_WIKI_CANISTER_ID__: JSON.stringify(target.canisterId),
    __KINIC_WIKI_IC_HOST__: JSON.stringify("https://icp0.io"),
    __KINIC_WIKI_DERIVATION_ORIGIN__: JSON.stringify(target.derivationOrigin),
    __KINIC_WIKI_SOURCE_TRIGGER_URL__: JSON.stringify(target.triggerUrl),
    __KINIC_WIKI_ORIGIN__: JSON.stringify(target.wikiOrigin)
  },
  legalComments: "none"
});

if (staging) {
  await Promise.all([
    cp(resolve(root, "icons"), resolve(outputRoot, "icons"), { recursive: true }),
    cp(resolve(root, "offscreen"), resolve(outputRoot, "offscreen"), { recursive: true }),
    cp(resolve(root, "popup"), resolve(outputRoot, "popup"), {
      recursive: true,
      filter: (source) => !source.endsWith("popup.js") && !source.endsWith("popup-state.js")
    })
  ]);
  const manifest = JSON.parse(await readFile(resolve(root, "manifest.json"), "utf8"));
  manifest.name = "Kinic Wiki Clipper (Staging)";
  manifest.key = stagingConfig.extensionKey;
  manifest.host_permissions = [
    "https://kinic-wiki-browser-staging.hude.workers.dev/*",
    "https://id.ai/*",
    "https://chatgpt.com/*",
    "https://chat.openai.com/*",
    "https://claude.ai/*",
    "https://gemini.google.com/*",
    "https://icp0.io/*",
    `https://${stagingConfig.canisterId}.icp0.io/*`
  ];
  await writeFile(resolve(outputRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

console.log(
  staging
    ? "built complete staging extension in tmp/staging-unpacked"
    : "built dist/service-worker.js, dist/content-ui.js, dist/offscreen.js, and dist/popup.js"
);

function runtimeConfigPlugin(config) {
  return {
    name: "kinic-staging-runtime-config",
    setup(build) {
      build.onResolve({ filter: /runtime-config\.js$/ }, () => ({
        path: "runtime-config",
        namespace: "kinic-runtime"
      }));
      build.onLoad({ filter: /.*/, namespace: "kinic-runtime" }, () => ({
        loader: "js",
        contents: [
          `export const RUNTIME_CANISTER_ID = ${JSON.stringify(config.canisterId)};`,
          `export const RUNTIME_IC_HOST = ${JSON.stringify("https://icp0.io")};`,
          `export const RUNTIME_DERIVATION_ORIGIN = ${JSON.stringify(config.derivationOrigin)};`,
          `export const RUNTIME_SOURCE_TRIGGER_URL = ${JSON.stringify(config.triggerUrl)};`,
          `export const RUNTIME_WIKI_ORIGIN = ${JSON.stringify(config.wikiOrigin)};`
        ].join("\n")
      }));
    }
  };
}

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
