// cf generates runtime types; binding declarations are resolved for every supported mode.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { loadConfig } from "./config.mjs";

const project = basename(process.cwd());
const runtime = project === "payment";
const result = spawnSync("pnpm", ["exec", "cf", "workers", "types", "--include-runtime", String(runtime)], { stdio: "inherit" });
if (result.status !== 0) process.exit(result.status ?? 1);
const modes = [undefined, ...(["wiki-generator", "wiki-assistant", "wikibrowser"].includes(project) ? ["staging"] : []), ...(runtime ? ["sandbox"] : [])];
const environments = await Promise.all(modes.map(async mode => (await loadConfig(process.cwd(), mode)).worker.env));
const bindingTypes = {
  secret: "string", text: "string", json: "unknown", d1: "D1Database", kv: "KVNamespace", r2: "R2Bucket",
  queue: "Queue", worker: "Fetcher", "rate-limit": "RateLimit", "unsafe:ratelimit": "RateLimit",
  "durable-object": "DurableObjectNamespace"
};
const allNames = [...new Set(environments.flatMap(env => Object.keys(env)))].sort();
let content = "/* eslint-disable */\n// Generated from cloudflare.config.ts by pnpm cf-typegen.\n";
content += "declare namespace Cloudflare {\n\tinterface Env {\n";
for (const name of allNames) {
  const types = [...new Set(environments.filter(env => name in env).map(env => {
    const type = bindingTypes[env[name].type];
    if (!type) throw new Error(`Unsupported binding type: ${env[name].type}`);
    return type;
  }))];
  const optional = environments.some(env => !(name in env)) ? "?" : "";
  content += `\t\t${JSON.stringify(name)}${optional}: ${types.join(" | ")};\n`;
}
content += "\t}\n}\ninterface Env extends Cloudflare.Env {}\n";
if (runtime) content += "interface PaymentBindings extends Cloudflare.Env {}\n";
if (project === "wiki-assistant") content += "interface AssistantEnv extends Cloudflare.Env {}\n";
if (runtime) {
  const generated = readFileSync(".cloudflare/types/index.d.ts", "utf8");
  const marker = "// Begin runtime types";
  const index = generated.indexOf(marker);
  if (index < 0) throw new Error("cf runtime types marker changed; inspect the pinned CLI output");
  content += generated.slice(index);
}
const output = project === "wiki-generator" ? "src/worker-configuration.d.ts"
  : project === "wikibrowser" ? "cloudflare-env.d.ts" : "worker-configuration.d.ts";
if (process.argv.includes("--check")) {
  if (readFileSync(output, "utf8") !== content) {
    console.error(`${output} is stale; run pnpm cf-typegen`);
    process.exitCode = 1;
  }
} else writeFileSync(output, content);
