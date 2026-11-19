// Run only against an explicitly owned, anonymous synthetic form.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const [app, raw, artifacts] = process.argv.slice(2);
assert.ok(["wiki", "vault"].includes(app));
const url = new URL(raw);
assert.ok(
  url.protocol === "http:" &&
    ["127.0.0.1", "localhost"].includes(url.hostname) &&
    url.port &&
    !url.username &&
    !url.password,
);
assert.ok(
  app === "wiki"
    ? url.pathname === "/cycles"
    : url.searchParams.get("state") === "funding",
);
mkdirSync(artifacts, { recursive: true });
const manifest = resolve(import.meta.dirname, "../fixtures/payments/copy.txt");
for (const [verb, gate] of [
  ["check", "integrity"],
  ["check", "copy"],
  ["scan", "scroll"],
  ["scan", "handlers"],
  ["check", "interactions"],
]) {
  const args = [
    "--config.verifyDepsBeforeRun=false",
    "--dir",
    "wikibrowser",
    "exec",
    "vlmkit",
    verb,
    gate,
    raw,
    ...(gate === "copy" ? ["--manifest", manifest] : []),
    "--json",
  ];
  const run = spawnSync("pnpm", args, {
    encoding: "utf8",
    maxBuffer: 10_000_000,
  });
  writeFileSync(resolve(artifacts, app + "-" + gate + ".json"), run.stdout);
  if (run.stderr)
    writeFileSync(resolve(artifacts, app + "-" + gate + ".stderr"), run.stderr);
  console.log(app, gate, "exit", run.status);
  if (run.status !== 0) process.exitCode = 1;
}
