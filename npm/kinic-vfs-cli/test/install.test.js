// Where: npm/kinic-vfs-cli/test/install.test.js
// What: Unit coverage for npm installer platform and checksum helpers.
// Why: Unsupported platforms must fail before any release download happens.
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { expectedSha256, releaseAsset, resolveReleasePlatform } = require("../scripts/install");

test("maps supported platforms to release asset names", () => {
  assert.equal(resolveReleasePlatform("darwin", "arm64"), "macos-arm64");
  assert.equal(resolveReleasePlatform("linux", "x64"), "linux-x86_64");
});

test("rejects unsupported platforms with cargo fallback", () => {
  assert.throws(() => resolveReleasePlatform("darwin", "x64"), /cargo install/);
  assert.throws(() => resolveReleasePlatform("win32", "x64"), /Unsupported platform/);
});

test("builds release asset URLs from package version and platform", () => {
  const asset = releaseAsset("0.1.2", "macos-arm64");
  assert.equal(asset.file, "kinic-vfs-cli-v0.1.2-macos-arm64.tar.gz");
  assert.equal(
    asset.tarUrl,
    "https://github.com/ICME-Lab/kinic-wiki/releases/download/v0.1.2/kinic-vfs-cli-v0.1.2-macos-arm64.tar.gz",
  );
  assert.equal(
    asset.shaUrl,
    "https://github.com/ICME-Lab/kinic-wiki/releases/download/v0.1.2/kinic-vfs-cli-v0.1.2-macos-arm64.sha256",
  );
});

test("parses sha256 checksum text", () => {
  assert.equal(
    expectedSha256("232a81c1a3ecd0b7d1c3e189e276fe5bf56fb546b6d14900bdbfee4cce9e5b24  file.tar.gz\n"),
    "232a81c1a3ecd0b7d1c3e189e276fe5bf56fb546b6d14900bdbfee4cce9e5b24",
  );
  assert.throws(() => expectedSha256("not a checksum"), /SHA-256/);
});
