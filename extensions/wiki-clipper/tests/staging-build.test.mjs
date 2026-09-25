// Where: extensions/wiki-clipper/tests/staging-build.test.mjs
// What: Verify the unpacked staging artifact is complete and production-isolated.
// Why: A mixed endpoint or extension key could leak staging captures into production.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);
const root = new URL("../", import.meta.url);
const artifact = new URL("../tmp/staging-unpacked/", import.meta.url);

test("build:staging produces an isolated unpacked extension", async () => {
  await run(process.execPath, ["scripts/build.mjs", "--staging"], { cwd: root });

  const [manifestText, serviceWorker, contentUi, offscreen, popup, popupHtml] = await Promise.all([
    readFile(new URL("manifest.json", artifact), "utf8"),
    readFile(new URL("dist/service-worker.js", artifact), "utf8"),
    readFile(new URL("dist/content-ui.js", artifact), "utf8"),
    readFile(new URL("dist/offscreen.js", artifact), "utf8"),
    readFile(new URL("dist/popup.js", artifact), "utf8"),
    readFile(new URL("popup/popup.html", artifact), "utf8")
  ]);
  const manifest = JSON.parse(manifestText);
  const artifactText = [manifestText, serviceWorker, contentUi, offscreen, popup].join("\n");

  assert.equal(manifest.name, "Kinic Wiki Clipper (Staging)");
  assert.equal(manifest.key.startsWith("MIIBIjAN"), true);
  assert.equal(extensionIdForKey(manifest.key), "kdildjebipiaccglghfdhjifgknlpffg");
  assert.notEqual(manifest.key, JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8")).key);
  assert.ok(manifest.host_permissions.includes("https://kinic-wiki-browser-staging.hude.workers.dev/*"));
  assert.ok(manifest.host_permissions.includes("https://3ryrw-kyaaa-aaaaf-qgxpq-cai.icp0.io/*"));
  assert.ok(!manifest.host_permissions.includes("https://wiki.kinic.xyz/*"));
  assert.ok(!manifest.host_permissions.includes("https://6emaw-iyaaa-aaaay-aacka-cai.icp0.io/*"));
  assert.match(artifactText, /3ryrw-kyaaa-aaaaf-qgxpq-cai/);
  assert.match(artifactText, /kinic-wiki-browser-staging\.hude\.workers\.dev/);
  assert.doesNotMatch(artifactText, /6emaw-iyaaa-aaaay-aacka-cai/);
  assert.doesNotMatch(artifactText, /https:\/\/wiki\.kinic\.xyz/);
  assert.match(popupHtml, /TypeSafe in the United States/);
  assert.match(popupHtml, /DeepSeek/);
});

function extensionIdForKey(key) {
  return createHash("sha256")
    .update(Buffer.from(key, "base64"))
    .digest("hex")
    .slice(0, 32)
    .replace(/[0-9a-f]/g, (digit) => String.fromCharCode("a".charCodeAt(0) + Number.parseInt(digit, 16)));
}
