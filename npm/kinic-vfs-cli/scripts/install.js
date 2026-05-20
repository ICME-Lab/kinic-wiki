#!/usr/bin/env node
// Where: npm/kinic-vfs-cli/scripts/install.js
// What: Download and verify the platform release binary for npm installs.
// Why: Keep npm distribution thin while GitHub Release remains the binary source.
"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");

const PACKAGE_ROOT = path.resolve(__dirname, "..");
const VENDOR_DIR = path.join(PACKAGE_ROOT, "vendor");
const BINARY_PATH = path.join(VENDOR_DIR, "kinic-vfs-cli");
const REPOSITORY_RELEASES = "https://github.com/ICME-Lab/kinic-wiki/releases/download";

function packageVersion() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"));
  return packageJson.version;
}

function resolveReleasePlatform(platform = process.platform, arch = process.arch) {
  if (platform === "darwin" && arch === "arm64") return "macos-arm64";
  if (platform === "linux" && arch === "x64") return "linux-x86_64";
  throw new Error(
    [
      `Unsupported platform: ${platform}-${arch}.`,
      "kinic-vfs-cli npm install currently supports darwin-arm64 and linux-x64.",
      "Fallback: cargo install --git https://github.com/ICME-Lab/kinic-wiki.git --package kinic-vfs-cli --bin kinic-vfs-cli --locked",
    ].join(" "),
  );
}

function releaseAsset(version, releasePlatform) {
  const file = `kinic-vfs-cli-v${version}-${releasePlatform}.tar.gz`;
  const baseUrl = `${REPOSITORY_RELEASES}/v${version}/${file}`;
  return { file, tarUrl: baseUrl, shaUrl: `${baseUrl.replace(/\.tar\.gz$/, ".sha256")}` };
}

function download(url, destination, redirectCount = 0) {
  if (redirectCount > 5) {
    return Promise.reject(new Error(`too many redirects while downloading ${url}`));
  }

  return new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      const statusCode = response.statusCode ?? 0;
      if (statusCode >= 300 && statusCode < 400 && response.headers.location) {
        response.resume();
        download(new URL(response.headers.location, url).toString(), destination, redirectCount + 1)
          .then(resolve)
          .catch(reject);
        return;
      }
      if (statusCode !== 200) {
        response.resume();
        reject(new Error(`download failed for ${url}: HTTP ${statusCode}`));
        return;
      }

      const file = fs.createWriteStream(destination);
      response.pipe(file);
      file.on("finish", () => file.close(resolve));
      file.on("error", reject);
    });
    request.on("error", reject);
  });
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function expectedSha256(shaText) {
  const match = shaText.match(/\b[a-fA-F0-9]{64}\b/);
  if (!match) throw new Error("release checksum file does not contain a SHA-256 digest");
  return match[0].toLowerCase();
}

function extractBinary(tarballPath, workDir) {
  const extractDir = path.join(workDir, "extract");
  fs.mkdirSync(extractDir, { recursive: true });
  const result = childProcess.spawnSync("tar", ["-xzf", tarballPath, "-C", extractDir], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`failed to extract release tarball: ${result.stderr || result.stdout}`);
  }

  const extractedBinary = path.join(extractDir, "kinic-vfs-cli");
  if (!fs.existsSync(extractedBinary)) {
    throw new Error("release tarball did not contain kinic-vfs-cli");
  }

  fs.rmSync(VENDOR_DIR, { force: true, recursive: true });
  fs.mkdirSync(VENDOR_DIR, { recursive: true });
  fs.copyFileSync(extractedBinary, BINARY_PATH);
  fs.chmodSync(BINARY_PATH, 0o755);
}

async function install() {
  const version = packageVersion();
  const releasePlatform = resolveReleasePlatform();
  const asset = releaseAsset(version, releasePlatform);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "kinic-vfs-cli-npm-"));
  const tarballPath = path.join(workDir, asset.file);
  const shaPath = path.join(workDir, `${asset.file.replace(/\.tar\.gz$/, ".sha256")}`);

  try {
    await download(asset.tarUrl, tarballPath);
    await download(asset.shaUrl, shaPath);

    const expected = expectedSha256(fs.readFileSync(shaPath, "utf8"));
    const actual = sha256File(tarballPath);
    if (actual !== expected) {
      throw new Error(`checksum mismatch for ${asset.file}: expected ${expected}, got ${actual}`);
    }

    extractBinary(tarballPath, workDir);
    console.log(`installed kinic-vfs-cli ${version} for ${releasePlatform}`);
  } finally {
    fs.rmSync(workDir, { force: true, recursive: true });
  }
}

if (require.main === module) {
  install().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = {
  expectedSha256,
  releaseAsset,
  resolveReleasePlatform,
};
