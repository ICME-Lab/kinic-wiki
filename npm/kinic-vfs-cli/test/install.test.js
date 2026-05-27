// Where: npm/kinic-vfs-cli/test/install.test.js
// What: Unit coverage for npm installer platform and checksum helpers.
// Why: Unsupported platforms must fail before any release download happens.
"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const path = require("node:path");
const test = require("node:test");

const { expectedSha256, releaseAsset, resolveReleasePlatform, validateTarEntries } = require("../scripts/install");

const repoRoot = path.resolve(__dirname, "../../..");

test("maps supported platforms to release asset names", () => {
  assert.equal(resolveReleasePlatform("darwin", "arm64"), "macos-arm64");
  assert.equal(resolveReleasePlatform("linux", "x64"), "linux-x86_64");
});

test("rejects unsupported platforms with cargo fallback", () => {
  assert.throws(() => resolveReleasePlatform("darwin", "x64"), /cargo install/);
  assert.throws(() => resolveReleasePlatform("win32", "x64"), /Unsupported platform/);
});

test("builds release asset URLs from package version and platform", () => {
  const asset = releaseAsset("0.1.3", "macos-arm64");
  assert.equal(asset.file, "kinic-vfs-cli-v0.1.3-macos-arm64.tar.gz");
  assert.equal(
    asset.tarUrl,
    "https://github.com/ICME-Lab/kinic-wiki/releases/download/v0.1.3/kinic-vfs-cli-v0.1.3-macos-arm64.tar.gz",
  );
  assert.equal(
    asset.shaUrl,
    "https://github.com/ICME-Lab/kinic-wiki/releases/download/v0.1.3/kinic-vfs-cli-v0.1.3-macos-arm64.sha256",
  );
});

test("release version script checks Cargo and npm parity", () => {
  const result = childProcess.spawnSync("bash", ["scripts/kinic_vfs_cli_release_version.sh"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "v0.1.3");
});

test("npm publish guard only allows the matching tag", () => {
  assert.notEqual(runPublishGuard({ GITHUB_REF_TYPE: "branch", GITHUB_REF_NAME: "feature" }).status, 0);
  assert.notEqual(runPublishGuard({ GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v0.1.1" }).status, 0);
  assert.equal(runPublishGuard({ GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v0.1.3" }).status, 0);
});

test("parses sha256 checksum text", () => {
  assert.equal(
    expectedSha256("232a81c1a3ecd0b7d1c3e189e276fe5bf56fb546b6d14900bdbfee4cce9e5b24  file.tar.gz\n", "file.tar.gz"),
    "232a81c1a3ecd0b7d1c3e189e276fe5bf56fb546b6d14900bdbfee4cce9e5b24",
  );
  assert.throws(() => expectedSha256("not a checksum"), /SHA-256/);
  assert.throws(
    () => expectedSha256("232a81c1a3ecd0b7d1c3e189e276fe5bf56fb546b6d14900bdbfee4cce9e5b24  other.tar.gz\n", "file.tar.gz"),
    /expected file\.tar\.gz/,
  );
});

test("rejects unsafe tarball entries before extraction", () => {
  withSpawnSync(
    [
      { status: 0, stdout: "../kinic-vfs-cli\n", stderr: "" },
      { status: 0, stdout: "-rwxr-xr-x 0 0 0 1 2026-01-01 00:00 ../kinic-vfs-cli\n", stderr: "" },
    ],
    () => assert.throws(() => validateTarEntries("release.tar.gz"), /unsafe path/),
  );
});

test("rejects symlink tarball entries before extraction", () => {
  withSpawnSync(
    [
      { status: 0, stdout: "kinic-vfs-cli\n", stderr: "" },
      { status: 0, stdout: "lrwxr-xr-x 0 0 0 1 2026-01-01 00:00 kinic-vfs-cli -> /tmp/x\n", stderr: "" },
    ],
    () => assert.throws(() => validateTarEntries("release.tar.gz"), /symlink/),
  );
});

test("rejects tarball with duplicate binaries", () => {
  withSpawnSync(
    [
      { status: 0, stdout: "kinic-vfs-cli\nkinic-vfs-cli\n", stderr: "" },
      {
        status: 0,
        stdout: "-rwxr-xr-x 0 0 0 1 2026-01-01 00:00 kinic-vfs-cli\n-rwxr-xr-x 0 0 0 1 2026-01-01 00:00 kinic-vfs-cli\n",
        stderr: "",
      },
    ],
    () => assert.throws(() => validateTarEntries("release.tar.gz"), /exactly one/),
  );
});

function withSpawnSync(results, callback) {
  const original = childProcess.spawnSync;
  let index = 0;
  childProcess.spawnSync = () => results[index++];
  try {
    callback();
  } finally {
    childProcess.spawnSync = original;
  }
}

function runPublishGuard(env) {
  return childProcess.spawnSync("bash", ["scripts/guard_kinic_vfs_cli_npm_publish.sh"], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}
