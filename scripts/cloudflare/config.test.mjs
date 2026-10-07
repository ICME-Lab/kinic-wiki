import { parse } from "jsonc-parser";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { loadConfig, loadWorkerConfig } from "./config.mjs";

const projects = ["wikibrowser", "skill-registry-web", "workers/wiki-generator", "workers/wiki-assistant"];
const targets = projects.flatMap(project => [
  [project, undefined, "wrangler.jsonc"],
  ...(["wikibrowser", "workers/wiki-generator", "workers/wiki-assistant"].includes(project) ? [[project, "staging", "wrangler.jsonc"]] : [])
]).concat([
  ["workers/payment", undefined, "wrangler.jsonc"],
  ["workers/payment", "sandbox", "wrangler.sandbox.jsonc"],
  ["workers/payment", "production", "wrangler.production.jsonc.example", "cloudflare.production.example.ts"],
  ...["public", "private", "staging", "private-v5-unbind", "staging-v5-unbind"].map(mode => ["workers/wiki-mcp", mode, mode === "public" ? "wrangler.jsonc" : `wrangler.${mode}.jsonc`])
]);
const fields = ["name", "account_id", "main", "compatibility_date", "compatibility_flags", "workers_dev", "observability", "vars", "routes", "kv_namespaces", "r2_buckets", "services", "d1_databases", "queues", "ratelimits", "triggers", "unsafe", "durable_objects"];
function normalized(field, value, name) {
  if (["routes", "kv_namespaces", "r2_buckets", "services", "d1_databases", "ratelimits"].includes(field)) value ??= [];
  if (field === "routes") value = value.map(route => ({ ...route })).sort((a,b) => a.pattern.localeCompare(b.pattern));
  if (field === "d1_databases") value = value.map(({ migrations_dir, ...binding }) => binding);
  if (field === "durable_objects" && value) value = { bindings: value.bindings.map(binding => {
    const out = { ...binding }; if (out.script_name === name) delete out.script_name; return out;
  }) };
  return value;
}
for (const [project, mode, fixture, filename] of targets) {
  test(`cf preserves ${project} ${mode ?? "default"} resources and boundaries`, async () => {
    const root = resolve(project);
    let legacy = parse(readFileSync(resolve(root, fixture), "utf8"));
    if (fixture === "wrangler.jsonc" && mode === "staging") legacy = { ...legacy, ...legacy.env.staging };
    const native = await loadWorkerConfig(root, mode, filename);
    for (const field of fields) {
      // The migration fixture predates the native assistant connection added
      // after migration. Require that exact new binding in both modes while
      // continuing to compare every other resource against the fixture.
      const expected = project === "workers/wiki-assistant" && field === "durable_objects"
        ? { bindings: [{ name: "ASSISTANT_CONNECTION", class_name: "AssistantConnection" }] }
        : legacy[field];
      assert.deepEqual(normalized(field, native[field], native.name), normalized(field, expected, legacy.name), field);
    }
    if (project === "workers/wiki-assistant") {
      const { worker } = await loadConfig(root, mode);
      assert.equal(worker.exports.AssistantConnection.storage, "sqlite");
      assert.deepEqual(Object.keys(worker.exports), ["AssistantConnection"]);
    }
    if (legacy.migrations) {
      const { worker } = await loadConfig(root, mode);
      const retired = new Set(); const live = new Set();
      for (const migration of legacy.migrations) {
        for (const name of migration.new_sqlite_classes ?? []) live.add(name);
        for (const name of migration.deleted_classes ?? []) { live.delete(name); retired.add(name); }
      }
      for (const name of live) assert.equal(worker.exports[name].storage, "sqlite");
      for (const name of retired) assert.equal(worker.exports[name].state, "deleted");
      assert.deepEqual(new Set(Object.keys(worker.exports)), new Set([...live, ...retired]));
    }
  });
}
