import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { writeRootConfig, writeWorkerConfig, getWorkerBundleDir, getWorkerConfigPath } from "@cloudflare/build-output-utils";

for (const scenario of ["preserve", "list-fails", "collision", "dry-run"]) {
  test(`deploy wrapper: ${scenario}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "cf-deploy-test-"));
    try {
      const env = { LABEL: { type: "text", value: "unchanged" } };
      const worker = { name: "fixture", entrypoint: "index.js", compatibilityDate: "2026-07-15", env };
      writeFileSync(join(root, "package.json"), '{"type":"module"}');
      writeFileSync(join(root, "cloudflare.config.ts"), `export default ${JSON.stringify({ worker })}`);
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
      const result = spawnSync(process.execPath, [resolve("scripts/cloudflare/deploy.mjs"), "--prebuilt", "--profile", "fixture", ...(scenario === "dry-run" ? ["--dry-run"] : [])], { cwd: root, env: childEnv, encoding: "utf8" });
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
        if (scenario === "preserve") {
          assert.deepEqual(config.env.OPTIONAL_TOKEN, { type: "secret" });
          assert.ok(calls[0].includes("fixture"));
        } else assert.equal(calls.some(args => args.includes("list")), false);
      }
    } finally { rmSync(root, { recursive: true }); }
  });
}
