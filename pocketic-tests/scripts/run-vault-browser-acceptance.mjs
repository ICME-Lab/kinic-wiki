// Disposable local network only. No production identity, ledger or existing mapping is modified.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
const root = fileURLToPath(new URL("../../", import.meta.url));
const port = Number(process.env.VAULT_ACCEPTANCE_PORT ?? 8044);
assert.ok(Number.isInteger(port) && port > 1024 && port < 65536);
// Never accidentally reuse a user server merely because it answers HTTP.
for (const testPort of [port, 3100])
  await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(testPort, "127.0.0.1", () => probe.close(resolve));
  });
const identity = process.env.VAULT_ACCEPTANCE_IDENTITY;
const idArgs = identity ? ["--identity", identity] : [];
const run = (cmd, args, env = {}) =>
  execFileSync(cmd, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: "inherit",
  });
const output = (cmd, args) =>
  execFileSync(cmd, args, { cwd: root, encoding: "utf8" }).trim();
assert.match(
  output("icp", ["--version"]),
  /1\.0\.2/,
  "Use the tested icp-cli 1.0.2",
);
mkdirSync(join(root, "target"), { recursive: true });
const project = mkdtempSync(join(root, "target/vault-browser-network-"));
const pnpm = [
  "--config.verifyDepsBeforeRun=false",
  "--config.managePackageManagerVersions=false",
];
writeFileSync(
  join(project, "icp.yaml"),
  `canisters:\n${["wiki", "vault", "ledger", "ii", "ii_frontend"].map((name) => `  - name: ${name}\n    build:\n      steps:\n        - type: script\n          commands: ["false"]`).join("\n")}\nnetworks:\n  - name: acceptance\n    mode: managed\n    ii: false\n    gateway:\n      bind: 127.0.0.1\n      port: ${port}\nenvironments:\n  - name: acceptance\n    network: acceptance\n    canisters: [wiki, vault, ledger, ii, ii_frontend]\n`,
);
const scope = ["--project-root-override", project, "-e", "acceptance"];
const icp = (args) => run("icp", [...args, ...scope, ...idArgs]);
const hash = (b) => createHash("sha256").update(b).digest("hex");
run("node", ["pocketic-tests/scripts/build-vault-client-acceptance.mjs"]);
const artifacts = {};
for (const [name, sha] of [
  [
    "internet_identity_dev",
    "620d21e404330fa93ffa047a9302dbfa6c63ecef706d33f76b28adea104a05d9",
  ],
  [
    "internet_identity_frontend",
    "62e6539d4ddeeaf47456c10eda7b04c5bc2446f246542460c7f9c5bddc80a2e0",
  ],
]) {
  const url = `https://github.com/dfinity/internet-identity/releases/download/release-2026-05-08/${name}.wasm.gz`;
  const response = await fetch(url);
  assert.ok(response.ok, `${url}: ${response.status}`);
  const compressed = Buffer.from(await response.arrayBuffer());
  assert.equal(hash(compressed), sha);
  const wasm = gunzipSync(compressed);
  writeFileSync(join(project, `${name}.wasm`), wasm);
  artifacts[name] = { url, gzip_sha256: sha, wasm_sha256: hash(wasm) };
}
let started = false,
  vite;
try {
  run("icp", [
    "network",
    "start",
    "acceptance",
    "--background",
    "--project-root-override",
    project,
  ]);
  started = true;
  const ids = {};
  for (const name of ["wiki", "vault", "ledger", "ii", "ii_frontend"])
    ids[name] = output("icp", [
      "canister",
      "create",
      name,
      "--quiet",
      "--cycles",
      "10000000000000",
      ...scope,
      ...idArgs,
    ]);
  const vaultURL = `http://${ids.vault}.localhost:${port}`,
    iiURL = `http://${ids.ii_frontend}.localhost:${port}`;
  const wikiURL = "http://127.0.0.1:3100";
  const install = (name, wasm, args, mode = "install") =>
    icp([
      "canister",
      "install",
      name,
      "--mode",
      mode,
      "--wasm",
      wasm,
      "--args",
      args,
    ]);
  const backendArgs =
    "(opt record {captcha_config=opt record {max_unsolved_captchas=50:nat64;captcha_trigger=variant {Static=variant {CaptchaDisabled}}};dummy_auth=null;is_production=opt false})";
  const frontendArgs = `(record {backend_canister_id=principal "${ids.ii}";backend_origin="http://${ids.ii}.localhost:${port}";related_origins=null;fetch_root_key=opt true;analytics_config=null;dummy_auth=null;dev_csp=opt true})`;
  install("ii", join(project, "internet_identity_dev.wasm"), backendArgs);
  install(
    "ii_frontend",
    join(project, "internet_identity_frontend.wasm"),
    frontendArgs,
  );
  run("node", ["pocketic-tests/scripts/build-vault-ledger.mjs"]);
  install(
    "ledger",
    join(
      root,
      "target/wasm32-unknown-unknown/release/vault_ledger_fixture.wasm",
    ),
    "()",
  );
  run("pnpm", [...pnpm, "--dir", "vaultbrowser", "build"]);
  const build = join(root, "target/vault-acceptance-build");
  run(
    "cargo",
    [
      "build",
      "-p",
      "vault-canister",
      "-p",
      "vfs-canister",
      "--target",
      "wasm32-unknown-unknown",
      "--release",
      "--locked",
    ],
    {
      CARGO_TARGET_DIR: build,
      VAULT_LOCAL_ORIGIN: vaultURL,
      VAULT_LOCAL_HOST: `http://localhost:${port}`,
      VAULT_LOCAL_II: iiURL,
      KINIC_VFS_LOCAL_II_ORIGINS: "1",
    },
  );
  const controller = output("icp", ["identity", "principal", ...idArgs]);
  const wikiArgs = `(record {kinic_ledger_canister_id="${ids.ledger}";billing_authority_id="${controller}";iap_authority_id=null;cycles_per_kinic=1000:nat64;min_update_cycles=1000000:nat64;top_up=record{enabled=false;threshold_cycles=1000000000:nat;launcher_principal="aaaaa-aa"}})`;
  const vaultWasm = join(
    build,
    "wasm32-unknown-unknown/release/vault_canister.wasm",
  );
  install(
    "wiki",
    join(build, "wasm32-unknown-unknown/release/vfs_canister.wasm"),
    wikiArgs,
  );
  install("vault", vaultWasm, "()");
  icp([
    "canister",
    "call",
    "vault",
    "set_config",
    `(opt record {minimum_cycles=100000000000:nat64;origin="${vaultURL}";key_name="key_1";rp_id="${new URL(vaultURL).hostname}"})`,
    "--candid",
    join(root, "crates/vault_canister/vault.did"),
  ]);
  icp([
    "canister",
    "call",
    "vault",
    "set_funding_config",
    `(opt record {recipient=principal "${ids.vault}";ledger=principal "${ids.ledger}";cycles_per_kinic=2000000000000:nat64})`,
    "--candid",
    join(root, "crates/vault_canister/vault.did"),
  ]);
  writeFileSync(
    join(root, "target/vault-browser-provenance.json"),
    JSON.stringify(
      {
        source_commit: output("git", ["rev-parse", "HEAD"]),
        working_tree_diff_sha256: hash(output("git", ["diff", "--binary"])),
        project,
        ids,
        vaultURL,
        iiURL,
        wikiURL,
        artifacts,
        backendArgs,
        frontendArgs,
        vault_wasm_sha256: hash(readFileSync(vaultWasm)),
      },
      null,
      2,
    ) + "\n",
  );
  vite = spawn(
    "pnpm",
    [
      ...pnpm,
      "--dir",
      "wikibrowser",
      "exec",
      "vite",
      "dev",
      "--host",
      "127.0.0.1",
      "--port",
      "3100",
      "--strictPort",
    ],
    {
      cwd: root,
      stdio: "inherit",
      env: {
        ...process.env,
        VITE_WIKI_IC_HOST: `http://127.0.0.1:${port}`,
        VITE_ENABLE_LOCAL_II_E2E: "1",
        VITE_II_PROVIDER_URL: iiURL,
        VITE_KINIC_WIKI_CANISTER_ID: ids.wiki,
      },
    },
  );
  for (let i = 0; i < 120; i++) {
    if (vite.exitCode !== null)
      throw Error("Owned Wiki dev server failed (port may be in use)");
    try {
      if ((await fetch(wikiURL)).ok) break;
    } catch {}
    if (i === 119) throw Error("Wiki server did not start");
    await new Promise((r) => setTimeout(r, 250));
  }
  run("node", ["vaultbrowser/verify-acceptance.mjs"], {
    VAULT_ACCEPTANCE_URL: vaultURL,
    WIKI_ACCEPTANCE_URL: wikiURL,
    II_ACCEPTANCE_URL: iiURL,
    VAULT_ACCEPTANCE_PROJECT: project,
    VAULT_ACCEPTANCE_WASM: vaultWasm,
    VAULT_ACCEPTANCE_IDENTITY: identity ?? "",
  });
} finally {
  if (vite) vite.kill("SIGTERM");
  if (started)
    run("icp", [
      "network",
      "stop",
      "acceptance",
      "--project-root-override",
      project,
    ]);
  // Keep this unique project's data and mappings for diagnosis; never reset another project.
}
