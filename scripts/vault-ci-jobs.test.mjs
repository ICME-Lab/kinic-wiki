import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdtempSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
const yaml=readFileSync(new URL("../.github/workflows/ci.yml",import.meta.url),"utf8");

test("Wiki CI selects a payments-only change and skips unrelated documentation", () => {
  const run = yaml.match(/^      - id: paths\n(?:        [^\n]*\n)*?        run: \|\n((?:^          .*\n|^\n)+)/m)?.[1];
  assert.ok(run, "changed-area workflow step has an executable run block");
  const selector = run.replace(/^ {10}/gm, "")
    .replaceAll("${{ github.event_name }}", "pull_request")
    .replaceAll("${{ github.event.pull_request.base.sha }}", "base")
    .replaceAll("${{ github.event.pull_request.head.sha }}", "head");
  const temp = mkdtempSync(join(tmpdir(), "wiki-ci-paths-"));
  try {
    for (const [changedPath, selected] of [
      ["packages/payments/src/index.ts", true],
      ["docs/vault/team-access.md", false],
    ]) {
      const output = join(temp, String(selected));
      const result = spawnSync("bash", ["-c", 'git() { [[ "$*" == "diff --name-only base head" ]] && printf "%s\\n" "$CHANGED_PATH"; }\n' + selector], {
        cwd: new URL("../", import.meta.url),
        env: { ...process.env, GITHUB_OUTPUT: output, CHANGED_PATH: changedPath },
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.error?.message ?? result.stderr);
      const wiki = readFileSync(output, "utf8").split("\n").find((line) => line.startsWith("wikibrowser="));
      assert.equal(wiki, `wikibrowser=${selected}`, changedPath);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
test("Vault fast checks cover the shared payment package",()=>{
const job=yaml.split("  vault-fast-check:")[1]?.split("  vault-wasm-acceptance:")[0];
assert.match(job,/pnpm .*--filter (?:'@kinic\/payments'|@kinic\/payments).* -r test/);
assert.ok(job.includes("pnpm --dir packages/payments typecheck"));
assert.ok(job.includes('"$GITHUB_WORKSPACE/packages/payments/src"'));
});
test("Wasm ledger acceptance provisions its own Candid compiler",()=>{
const job=yaml.split("  vault-wasm-acceptance:")[1]?.split("  vault-browser-acceptance:")[0];
assert.ok(job?.includes("didc --version"),"isolated Wasm job needs pinned didc, not the fast job installation");
assert.ok(job.includes("sha256sum -c"));
});

test("browser job pins launcher path without an unauthenticated latest lookup",()=>{
const job=yaml.split("  vault-browser-acceptance:")[1];
assert.ok(job.includes("ICP_CLI_NETWORK_LAUNCHER_PATH"),"fresh icp home otherwise calls GitHub latest API and can hit shared runner rate limits");
assert.ok(job.includes("c843d039fbcada6d4ef5fa5dbfcff772c938a8b5e5d0e034fce52dc44f2bd001"));
});
