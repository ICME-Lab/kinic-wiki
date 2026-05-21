// Where: extensions/wiki-clipper/scripts/release-package.mjs
// What: Create the Chrome Web Store upload zip from built extension files.
// Why: The store package must contain runtime files only, not source, tests, env files, or dependencies.
import { cp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import manifest from "../manifest.json" with { type: "json" };

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = resolve(root, "release");
const stagingDir = resolve(releaseDir, "staging");
const zipPath = resolve(releaseDir, `kinic-wiki-clipper-${manifest.version}.zip`);
const packageRoots = ["manifest.json", "icons", "offscreen", "popup/popup.css", "popup/popup.html", "dist"];

await rm(releaseDir, { recursive: true, force: true });
await mkdir(stagingDir, { recursive: true });
await writeStoreManifest();
await copyPackageRoots();

const files = [];
for (const packageRoot of packageRoots) {
  await collectPackageFiles(packageRoot, files);
}

const result = spawnSync("/usr/bin/zip", ["-q", "-X", zipPath, ...files], {
  cwd: stagingDir,
  encoding: "utf8"
});
if (result.status !== 0) {
  console.error(result.stderr || result.stdout || "zip failed");
  process.exit(result.status || 1);
}
await rm(stagingDir, { recursive: true, force: true });

console.log(`created ${zipPath}`);

async function writeStoreManifest() {
  // Chrome Web Store assigns and signs the production ID. The manifest key is
  // only for unpacked local development and is rejected by store uploads.
  const { key, ...storeManifest } = manifest;
  void key;
  await writeFile(
    resolve(stagingDir, "manifest.json"),
    `${JSON.stringify(storeManifest, null, 2)}\n`,
    "utf8"
  );
}

async function copyPackageRoots() {
  for (const packageRoot of packageRoots) {
    if (packageRoot === "manifest.json") continue;
    const source = resolve(root, packageRoot);
    const target = resolve(stagingDir, packageRoot);
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target, {
      recursive: true
    });
  }
}

async function collectPackageFiles(relativePath, files) {
  const absolutePath = resolve(stagingDir, relativePath);
  const info = await stat(absolutePath);
  if (info.isDirectory()) {
    for (const entry of await readdir(absolutePath)) {
      if (entry.startsWith(".")) continue;
      await collectPackageFiles(`${relativePath}/${entry}`, files);
    }
    return;
  }
  files.push(relativePath);
}
