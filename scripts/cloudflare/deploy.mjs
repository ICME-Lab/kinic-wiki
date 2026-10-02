import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import { loadConfig } from "./config.mjs";
import { basename } from "node:path";
import { secretFileNames, preserveSecretBindings } from "./secrets.mjs";
import { readBuildOutput } from "@cloudflare/build-output-utils";

secretFileNames();
const args = ["exec", "cf", "deploy", ...process.argv.slice(2)];
if (process.env.CLOUDFLARE_SECRETS_FILE) args.push("--secrets-file", process.env.CLOUDFLARE_SECRETS_FILE);
const modeIndex = args.findIndex(arg => arg === "--mode" || arg === "-m");
const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const usesVite = Boolean(manifest.devDependencies?.["@cloudflare/vite-plugin"]);
const mode = modeIndex < 0 ? (usesVite ? "production" : undefined) : args[modeIndex + 1];
if (modeIndex < 0 && usesVite) args.push("--mode", mode);
const { worker } = await loadConfig(process.cwd(), mode);
const buildEnv = { ...process.env };
for (const [name, binding] of Object.entries(worker.env ?? {})) {
  if (name.startsWith("VITE_") && binding.type === "text") buildEnv[name] = binding.value;
}
if (basename(process.cwd()) === "wikibrowser" && mode === "staging") {
  buildEnv.VITE_ENABLE_LOCAL_II_E2E = "";
  buildEnv.VITE_II_PROVIDER_URL = "";
}
// cf beta cannot forward modes to detected TanStack commands. Use its official
// Vite delegate to produce mode-tagged output, then let cf deploy validate it.
if (usesVite && !args.includes("--prebuilt")) {
  const buildArgs = ["exec", "cf-vite", "build", ...(mode ? ["--mode", mode] : [])];
  const build = spawnSync("pnpm", buildArgs, { stdio: "inherit", env: {
    ...buildEnv, CLOUDFLARE_VITE_FORCE_BUILD_OUTPUT: "true"
  } });
  if (build.status !== 0) process.exit(build.status ?? 1);
  args.push("--prebuilt");
}
if (!args.includes("--prebuilt")) {
  const build = spawnSync("pnpm", ["exec", "cf", "build", ...(mode ? ["--mode", mode] : [])], { stdio: "inherit", env: buildEnv });
  if (build.status !== 0) process.exit(build.status ?? 1);
  args.push("--prebuilt");
}
const { workers } = await readBuildOutput(process.cwd());
const built = workers.default;
if (built.config.name !== worker.name) throw new Error("Build output targets a different Worker");
if (!args.includes("--dry-run")) {
  const profileIndex = args.indexOf("--profile");
  const profile = profileIndex < 0 ? [] : ["--profile", args[profileIndex + 1]];
  // Fail closed on auth/API errors: an incomplete list could erase live secrets.
  const listed = JSON.parse(execFileSync("pnpm", ["exec", "cf", "workers", "secrets", "list", "--worker", worker.name, ...profile], { encoding: "utf8", env: buildEnv }));
  if (!Array.isArray(listed) || listed.some(x => typeof x.name !== "string")) throw new Error("Invalid secret-name response");
  const names = new Set([...listed.map(x => x.name), ...secretFileNames()]);
  writeFileSync(built.configPath, JSON.stringify(preserveSecretBindings(built.config, names), null, 2));
}
const result = spawnSync("pnpm", args, { stdio: "inherit", env: buildEnv });
process.exit(result.status ?? 1);
