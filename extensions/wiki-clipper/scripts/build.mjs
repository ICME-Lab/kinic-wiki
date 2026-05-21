// Where: extensions/wiki-clipper/scripts/build.mjs
// What: Bundle the MV3 service worker, content UI, and popup scripts.
// Why: Chrome cannot resolve npm bare imports or local .env files directly.
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");
const env = await readEnvFile(resolve(root, ".env"));

await rm(dist, { recursive: true, force: true });
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
  jsx: "automatic",
  jsxImportSource: "preact",
  define: {
    "process.env.KINIC_CAPTURE_DATABASE_ID": JSON.stringify(env.KINIC_CAPTURE_DATABASE_ID || "")
  },
  legalComments: "none"
});

console.log("built dist/service-worker.js, dist/content-ui.js, dist/offscreen.js, and dist/popup.js");

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
