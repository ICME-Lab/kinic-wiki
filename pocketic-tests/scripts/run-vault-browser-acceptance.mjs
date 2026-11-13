// Disposable local network only. No production identity, ledger or existing mapping is modified.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  copyFileSync,
} from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
const root = fileURLToPath(new URL("../../", import.meta.url));
const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
const port = Number(process.env.VAULT_ACCEPTANCE_PORT ?? (await freePort()));
// Wiki's certified local alternative-origins list intentionally allows only
// these fixed dev origins. Probe before claiming one; never stop an occupant.
let wikiPort;
for (const candidate of [3100, 3010]) {
  try {
    await new Promise((resolve, reject) => {
      const probe = createServer();
      probe.once("error", reject);
      probe.listen(candidate, "127.0.0.1", () => probe.close(resolve));
    });
    wikiPort = candidate;
    break;
  } catch (e) {
    if (e.code !== "EADDRINUSE") throw e;
  }
}
assert.ok(wikiPort, "No free certified Wiki local origin (3100/3010)");
assert.ok(Number.isInteger(port) && port > 1024 && port < 65536);
// Never accidentally reuse a user server merely because it answers HTTP.
for (const testPort of [port, wikiPort])
  await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(testPort, "127.0.0.1", () => probe.close(resolve));
  });
const idArgs = ["--identity", "vault-browser-fixture"];
const run = (cmd, args, env = {}) =>
  execFileSync(cmd, args, {
    cwd: root,
    env: { ...process.env, ...fixtureEnv, ...env },
    stdio: "inherit",
  });
const output = (cmd, args) =>
  execFileSync(cmd, args, {
    cwd: root,
    env: { ...process.env, ...fixtureEnv },
    encoding: "utf8",
  }).trim();
const fixtureEnv = {};
assert.match(
  output("icp", ["--version"]),
  /1\.0\.2/,
  "Use the tested icp-cli 1.0.2",
);
mkdirSync(join(root, "target"), { recursive: true });
const project = mkdtempSync(join(root, "target/vault-browser-network-"));
fixtureEnv.ICP_HOME = join(project, "cli-home");
fixtureEnv.DO_NOT_TRACK = "1";
let started = false,
  vite;
try {
  run("icp", [
    "identity",
    "new",
    "vault-browser-fixture",
    "--storage",
    "plaintext",
    "--output-seed",
    join(project, "controller-seed.txt"),
  ]);
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
  run("node", ["pocketic-tests/scripts/build-vault-browser-readback.mjs"]);
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
    const cache = join(root, "target/vault-browser-ii-cache");
    mkdirSync(cache, { recursive: true });
    const archive = join(cache, `${sha}.wasm.gz`);
    let compressed;
    if (existsSync(archive)) compressed = readFileSync(archive);
    else {
      const response = await fetch(url);
      assert.ok(response.ok, `${url}: ${response.status}`);
      compressed = Buffer.from(await response.arrayBuffer());
      assert.equal(hash(compressed), sha);
      writeFileSync(archive, compressed);
    }
    assert.equal(hash(compressed), sha);
    const wasm = gunzipSync(compressed);
    writeFileSync(join(project, `${name}.wasm`), wasm);
    artifacts[name] = { url, gzip_sha256: sha, wasm_sha256: hash(wasm) };
  }
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
  const wikiURL = `http://127.0.0.1:${wikiPort}`;
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
  const build =
    process.env.VAULT_BROWSER_BUILD_CACHE ??
    join(root, "target/vault-browser-build");
  const localBuildEnv = {
    CARGO_TARGET_DIR: build,
    VAULT_LOCAL_ORIGIN: vaultURL,
    VAULT_LOCAL_HOST: `http://localhost:${port}`,
    VAULT_LOCAL_II: iiURL,
    KINIC_VFS_LOCAL_II_ORIGINS: "1",
  };
  const cargoArgs = [
    "build",
    "-p",
    "vault-canister",
    "-p",
    "vfs-canister",
    "--target",
    "wasm32-unknown-unknown",
    "--release",
    "--locked",
  ];
  run(
    "cargo",
    [...cargoArgs, "--features", "vault-canister/synthetic-funding-test-only"],
    localBuildEnv,
  );
  const vaultWasm = join(project, "vault-synthetic-local.wasm");
  copyFileSync(
    join(build, "wasm32-unknown-unknown/release/vault_canister.wasm"),
    vaultWasm,
  );
  run("cargo", cargoArgs, localBuildEnv);
  const defaultLocalWasm = join(project, "vault-default-local.wasm");
  copyFileSync(
    join(build, "wasm32-unknown-unknown/release/vault_canister.wasm"),
    defaultLocalWasm,
  );
  const controller = output("icp", ["identity", "principal", ...idArgs]);
  const wikiArgs = `(record {kinic_ledger_canister_id="${ids.ledger}";billing_authority_id="${controller}";iap_authority_id=null;cycles_per_kinic=1000:nat64;min_update_cycles=1000000:nat64;top_up=record{enabled=false;threshold_cycles=1000000000:nat;launcher_principal="aaaaa-aa"}})`;
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
    `(opt record {minimum_cycles=100000000000:nat64;key_name="key_1"})`,
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
        funding_mode:
          "synthetic-test-only funding, then upgrade to default unavailable",
        deployable: false,
        source_commit: output("git", ["rev-parse", "HEAD"]),
        working_tree_diff_sha256: hash(
          output("git", ["diff", "HEAD", "--binary"]),
        ),
        project,
        ids,
        vaultURL,
        iiURL,
        wikiURL,
        artifacts,
        backendArgs,
        frontendArgs,
        synthetic_local_wasm_sha256: hash(readFileSync(vaultWasm)),
        default_local_wasm_sha256: hash(readFileSync(defaultLocalWasm)),
        harness: Object.fromEntries(
          [
            "pocketic-tests/scripts/run-vault-browser-acceptance.mjs",
            "pocketic-tests/scripts/build-vault-browser-readback.mjs",
            "vaultbrowser/verify-acceptance.mjs",
            "vaultbrowser/fixtures/acceptance-readback.ts",
          ].map((path) => [path, hash(readFileSync(join(root, path)))]),
        ),
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
      String(wikiPort),
      "--strictPort",
    ],
    {
      cwd: root,
      stdio: "inherit",
      detached: process.platform !== "win32",
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
    VAULT_ACCEPTANCE_WASM: defaultLocalWasm,
    VAULT_ACCEPTANCE_IDENTITY: "vault-browser-fixture",
    ...fixtureEnv,
  });
} finally {
  const cleanupErrors = [];
  try {
    if (vite && vite.exitCode === null) {
      const stopped = new Promise((resolve) => vite.once("exit", resolve));
      if (process.platform === "win32") vite.kill("SIGTERM");
      else process.kill(-vite.pid, "SIGTERM"); // Only this spawn's owned process group.
      await stopped;
    }
  } catch (e) {
    cleanupErrors.push(String(e));
  }
  try {
    if (started)
      run("icp", [
        "network",
        "stop",
        "acceptance",
        "--project-root-override",
        project,
      ]);
  } catch (e) {
    cleanupErrors.push(String(e));
  }
  rmSync(join(project, "controller-seed.txt"), { force: true });
  rmSync(join(project, "cli-home", "identity"), {
    recursive: true,
    force: true,
  });
  for (const ownedPort of [port, wikiPort]) {
    try {
      await new Promise((resolve, reject) => {
        const probe = createServer();
        probe.once("error", reject);
        probe.listen(ownedPort, "127.0.0.1", () => probe.close(resolve));
      });
    } catch (e) {
      cleanupErrors.push(`Port ${ownedPort}: ${e}`);
    }
  }
  writeFileSync(
    join(root, "target/vault-browser-teardown.json"),
    JSON.stringify(
      {
        project,
        ports: [port, wikiPort],
        fixtureIdentityRemoved: !existsSync(
          join(project, "cli-home", "identity"),
        ),
        errors: cleanupErrors,
      },
      null,
      2,
    ) + "\n",
  );
  assert.deepEqual(
    cleanupErrors,
    [],
    "Owned local infrastructure must fully stop",
  );
  // Keep only this owned project's data/mappings for diagnosis. Never reset another project.
}
