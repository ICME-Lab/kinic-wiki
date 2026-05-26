// Where: extensions/wiki-clipper/tests/web-source.test.mjs
// What: Unit tests for active-page DOM source rendering.
// Why: Web captures must save canonical raw sources before generation is queued.
import assert from "node:assert/strict";
import test from "node:test";
import { buildWebRawSource } from "../src/web-source.js";

test("buildWebRawSource emits canonical browser DOM source", async () => {
  const raw = await buildWebRawSource(
    {
      url: "https://example.com/post#section",
      title: "Example Post",
      text: "First paragraph.\n\nSecond paragraph."
    },
    new Date("2026-05-01T00:00:00.000Z")
  );

  assert.match(raw.path, /^\/Sources\/raw\/web\/[a-f0-9]{16}\.md$/);
  assert.equal(raw.path.split("/").at(-2), "web");
  assert.equal(raw.sourceId, `web-${raw.path.split("/").at(-1)?.replace(".md", "")}`);
  assert.match(raw.content, /kind: kinic\.raw_web_source/);
  assert.match(raw.content, /schema_version: 1/);
  assert.match(raw.content, /capture_method: browser_dom/);
  assert.match(raw.content, /url: "https:\/\/example\.com\/post"/);
  assert.match(raw.content, /text_chars: 35/);
  assert.match(raw.content, /truncated: "false"/);
  assert.match(raw.content, /original_chars: "35"/);
  assert.match(raw.content, /saved_chars: "35"/);
  assert.match(raw.content, /# Example Post/);
  assert.match(raw.content, /First paragraph\./);
  assert.deepEqual(JSON.parse(raw.metadataJson), {
    source_type: "url",
    url: "https://example.com/post",
    final_url: "https://example.com/post",
    title: "Example Post",
    captured_at: "2026-05-01T00:00:00.000Z",
    capture_method: "browser_dom",
    text_chars: 35,
    truncated: false,
    original_chars: 35,
    saved_chars: 35
  });
});

test("buildWebRawSource truncates oversized browser DOM text", async () => {
  const text = `${"a".repeat(300_000)}   \nSHOULD_NOT_BE_SAVED`;
  const raw = await buildWebRawSource(
    {
      url: "https://example.com/large",
      title: "Large Page",
      text
    },
    new Date("2026-05-01T00:00:00.000Z")
  );

  assert.match(raw.content, /truncated: "true"/);
  assert.match(raw.content, /original_chars: "300023"/);
  assert.match(raw.content, /saved_chars: "300000"/);
  assert.doesNotMatch(raw.content, /SHOULD_NOT_BE_SAVED/);
  assert.deepEqual(JSON.parse(raw.metadataJson), {
    source_type: "url",
    url: "https://example.com/large",
    final_url: "https://example.com/large",
    title: "Large Page",
    captured_at: "2026-05-01T00:00:00.000Z",
    capture_method: "browser_dom",
    text_chars: 300023,
    truncated: true,
    original_chars: 300023,
    saved_chars: 300000
  });
});

test("buildWebRawSource rejects empty page text", async () => {
  await assert.rejects(
    () => buildWebRawSource({ url: "https://example.com/", title: "Empty", text: "  " }),
    /page text is empty/
  );
});
