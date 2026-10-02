import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { writeRootConfig, writeWorkerConfig, getWorkerBundleDir, getWorkerConfigPath } from "@cloudflare/build-output-utils";

for (const scenario of ["preserve", "list-fails", "collision", "dry-run", "mode-equals", "profile-chain", "profile-chain-equals"]) {
  test(`deploy wrapper: ${scenario}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "cf-deploy-test-"));
    try {
      const env = { LABEL: { type: "text", value: "unchanged" } };
      const modeTest = scenario === "mode-equals";
      const worker = { name: modeTest ? "fixture-staging" : "fixture", entrypoint: "index.js", compatibilityDate: "2026-07-15", env };
      writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module", ...(modeTest ? { devDependencies: { "@cloudflare/vite-plugin": "fixture" } } : {}) }));
      writeFileSync(join(root, "cloudflare.config.ts"), `export default (ctx) => ({worker: {...${JSON.stringify(worker)}, name: ${modeTest} ? "fixture-" + (ctx.mode ?? "production") : "fixture"}})`);
      await writeRootConfig(root, {}, { isPreview: false });
      await writeWorkerConfig({ root, config: worker, manifest: { type: "complete", mainModule: "index.js", modules: { "index.js": { type: "esm" } } } });
      mkdirSync(getWorkerBundleDir(root), { recursive: true });
      writeFileSync(join(getWorkerBundleDir(root), "index.js"), 'export default {}');
      mkdirSync(join(root, "bin"));
      writeFileSync(join(root, "bin/pnpm"), `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync('calls.jsonl', JSON.stringify(args)+'\\n');
if(args.includes('list')) {
 if(process.env.SCENARIO==='list-fails') process.exit(1);
 console.log(JSON.stringify([{name: process.env.SCENARIO==='collision'?'LABEL':'OPTIONAL_TOKEN',type:'secret_text'}]));
}
`, { mode: 0o755 });
      const childEnv = { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, SCENARIO: scenario };
      delete childEnv.CLOUDFLARE_SECRETS_FILE;
      delete childEnv.KINIC_CF_PROFILE;
      const chainTest = scenario.startsWith("profile-chain");
      writeFileSync(join(root, "guard.mjs"), `import { assertWorkerSecrets } from ${JSON.stringify(new URL("./secrets.mjs", import.meta.url).href)}; assertWorkerSecrets(process.cwd(), "fixture", ["OPTIONAL_TOKEN"]);`);
      // Package scripts run the guard before the upload, not just the wrapper alone.
      const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
      const command = `${quote(process.execPath)} guard.mjs && ${quote(process.execPath)} ${quote(resolve("scripts/cloudflare/deploy.mjs"))} --prebuilt`;
      const invocation = chainTest
        ? [resolve("scripts/cloudflare/with-profile.mjs"), command, ...(scenario.endsWith("-equals") ? ["--profile=fixture"] : ["--profile", "fixture"])]
        : [resolve("scripts/cloudflare/deploy.mjs"), ...(modeTest ? ["--mode=staging"] : ["--prebuilt"]), "--profile=fixture", ...(scenario === "dry-run" ? ["--dry-run"] : [])];
      const result = spawnSync(process.execPath, invocation, { cwd: root, env: childEnv, encoding: "utf8" });
      assert.ok(existsSync(join(root, "calls.jsonl")), result.stderr);
      const calls = readFileSync(join(root, "calls.jsonl"), "utf8").trim().split('\n').map(JSON.parse);
      if (["list-fails", "collision"].includes(scenario)) {
        assert.notEqual(result.status, 0);
        assert.equal(calls.some(args => args.includes("deploy")), false);
      } else {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(calls.filter(args => args.includes("deploy")).length, 1);
        const config = JSON.parse(readFileSync(getWorkerConfigPath(root), "utf8"));
        assert.deepEqual(config.env.LABEL, env.LABEL);
        if (scenario !== "dry-run") {
          assert.deepEqual(config.env.OPTIONAL_TOKEN, { type: "secret" });
          for (const call of calls.filter(args => args.includes("list") || args.includes("deploy"))) {
            assert.equal(call[call.indexOf("--profile") + 1], "fixture");
          }
          if (chainTest) assert.equal(calls.filter(args => args.includes("list")).length, 2);
          if (modeTest) {
            assert.ok(calls.some(args => args.includes("cf-vite") && args.includes("build")));
            for (const call of calls.filter(args => args.includes("build") || args.includes("deploy"))) {
              assert.equal(call[call.indexOf("--mode") + 1], "staging");
              assert.equal(call.includes("production"), false);
            }
          }
        } else assert.equal(calls.some(args => args.includes("list")), false);
      }
    } finally { rmSync(root, { recursive: true }); }
  });
}
