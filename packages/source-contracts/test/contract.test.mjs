import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  fnv1aBase36,
  fnv1aHex,
  hostnameForUrl,
  isSafeSourceCaptureRequestId,
  isSourceCaptureRequestPath,
  sha256Hex,
  slugTitle,
  sourceStemFromTitleHash
} from "../index.js";

const fixture = JSON.parse(
  await readFile(new URL("../../../contracts/source-capture-contract.json", import.meta.url), "utf8")
);

test("shared source capture boundary fixture", async () => {
  for (const entry of fixture.requestIds) {
    assert.equal(isSafeSourceCaptureRequestId(entry.value), entry.valid, entry.value);
  }
  for (const entry of fixture.requestPaths) {
    assert.equal(isSourceCaptureRequestPath(entry.value), entry.valid, entry.value);
  }
  for (const entry of fixture.slugs) {
    assert.equal(slugTitle(entry.value, entry.fallback), entry.expected);
  }
  for (const entry of fixture.fnv1a) {
    assert.equal(fnv1aHex(entry.value), entry.hex);
    assert.equal(fnv1aBase36(entry.value), entry.base36);
  }
  for (const entry of fixture.sha256) {
    assert.equal(await sha256Hex(entry.value), entry.hex);
  }
  for (const entry of fixture.hostnames) {
    assert.equal(hostnameForUrl(entry.value), entry.expected);
  }
  assert.ok(new TextEncoder().encode(sourceStemFromTitleHash("会".repeat(100), "12345678")).length <= 128);
});
