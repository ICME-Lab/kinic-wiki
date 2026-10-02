import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

export function secretFileNames() {
  if (!process.env.CLOUDFLARE_SECRETS_FILE) return new Set();
  const data = JSON.parse(readFileSync(process.env.CLOUDFLARE_SECRETS_FILE, "utf8"));
  assert.ok(data && typeof data === "object" && !Array.isArray(data), "secrets file must be a JSON object");
  for (const [name, value] of Object.entries(data)) {
    assert.ok(typeof value === "string" && value.trim().length > 0, `missing value for secret: ${name}`);
  }
  return new Set(Object.keys(data));
}

export function assertWorkerSecrets(projectRoot, worker, required) {
  const names = secretFileNames();
  if (!required.every(name => names.has(name))) {
    const listed = JSON.parse(execFileSync("pnpm", ["exec", "cf", "workers", "secrets", "list", "--worker", worker], {
      cwd: projectRoot, encoding: "utf8"
    }));
    assert.ok(Array.isArray(listed), "cf secret list must return an array");
    for (const { name } of listed) names.add(name);
  }
  for (const name of required) assert.ok(names.has(name), `missing Worker secret: ${name}`);
}

// cf only inherits explicitly declared secrets. Preserve every existing name,
// including optional integrations, without reading or copying secret values.
export function preserveSecretBindings(worker, names) {
  const env = { ...worker.env };
  for (const name of names) {
    assert.ok(!env[name] || env[name].type === "secret", `secret conflicts with non-secret binding: ${name}`);
    env[name] = { type: "secret" };
  }
  return { ...worker, env };
}
