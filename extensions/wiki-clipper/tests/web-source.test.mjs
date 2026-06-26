// Where: extensions/wiki-clipper/tests/web-source.test.mjs
// What: Unit tests for active-page DOM source rendering.
// Why: Web captures must save canonical evidence sources before generation is queued.
import assert from "node:assert/strict";
import test from "node:test";
import { buildWebEvidenceSource, collectWebPageSnapshot, webSourcePathForUrl } from "../src/web-source.js";

test("buildWebEvidenceSource emits canonical browser DOM source", async () => {
  const raw = await buildWebEvidenceSource(
    {
      url: "https://example.com/post#section",
      title: "Example Post",
      text: "First paragraph.\n\nSecond paragraph."
    },
    new Date("2026-05-01T00:00:00.000Z")
  );

  assert.match(raw.path, /^\/Sources\/evidence\/web\/[a-f0-9]{16}\.md$/);
  assert.equal(raw.path.split("/").at(-2), "web");
  assert.equal(raw.sourceId, `web-${raw.path.split("/").at(-1)?.replace(".md", "")}`);
  assert.match(raw.content, /kind: kinic\.evidence_web_source/);
  assert.match(raw.content, /schema_version: 1/);
  assert.match(raw.content, /capture_method: browser_dom/);
  assert.match(raw.content, /url: "https:\/\/example\.com\/post"/);
  assert.match(raw.content, /text_chars: 35/);
  assert.match(raw.content, /truncated: false/);
  assert.match(raw.content, /original_chars: 35/);
  assert.match(raw.content, /saved_chars: 35/);
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

test("buildWebEvidenceSource path does not depend on title", async () => {
  const first = await buildWebEvidenceSource(
    {
      url: "https://example.com/post",
      title: ' 日本語 / Path: *Bad? "Title" <x> | end. ',
      text: "Body"
    },
    new Date("2026-05-01T00:00:00.000Z")
  );

  const second = await buildWebEvidenceSource(
    {
      url: "https://example.com/post",
      title: "",
      text: "Body"
    },
    new Date("2026-05-01T00:00:00.000Z")
  );

  assert.equal(first.path, second.path);
  assert.match(first.path, /^\/Sources\/evidence\/web\/[a-f0-9]{16}\.md$/);
});

test("webSourcePathForUrl ignores hash fragments", async () => {
  assert.equal(
    await webSourcePathForUrl("https://example.com/post#section"),
    await webSourcePathForUrl("https://example.com/post")
  );
});

test("buildWebEvidenceSource truncates oversized browser DOM text", async () => {
  const text = `${"a".repeat(300_000)}   \nSHOULD_NOT_BE_SAVED`;
  const raw = await buildWebEvidenceSource(
    {
      url: "https://example.com/large",
      title: "Large Page",
      text
    },
    new Date("2026-05-01T00:00:00.000Z")
  );

  assert.match(raw.content, /truncated: true/);
  assert.match(raw.content, /original_chars: 300023/);
  assert.match(raw.content, /saved_chars: 300000/);
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

test("buildWebEvidenceSource rejects empty page text", async () => {
  await assert.rejects(
    () => buildWebEvidenceSource({ url: "https://example.com/", title: "Empty", text: "  " }),
    /page text is empty/
  );
});

test("collectWebPageSnapshot preserves paragraph breaks and limits excessive blank lines", () => {
  const previousDocument = globalThis.document;
  const previousLocation = globalThis.location;
  try {
    const article = fakeElement(
      "First paragraph.   \n\n\n\nSecond paragraph.\n\n\nThird paragraph.",
      [],
      []
    );
    globalThis.document = {
      title: "Example",
      body: article,
      querySelectorAll(selector) {
        return selector === "article,main,[role='main']" ? [article] : [];
      }
    };
    globalThis.location = { href: "https://example.com/" };

    const snapshot = collectWebPageSnapshot();

    assert.equal(snapshot.text, "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.");
  } finally {
    globalThis.document = previousDocument;
    globalThis.location = previousLocation;
  }
});

test("collectWebPageSnapshot caps extracted text before normalizing huge pages", () => {
  const previousDocument = globalThis.document;
  const previousLocation = globalThis.location;
  try {
    const article = fakeElement(`${"a".repeat(400_000)}SHOULD_NOT_BE_CAPTURED`, [], []);
    globalThis.document = {
      title: "Huge",
      body: article,
      querySelectorAll(selector) {
        return selector === "article,main,[role='main']" ? [article] : [];
      }
    };
    globalThis.location = { href: "https://example.com/huge" };

    const snapshot = collectWebPageSnapshot();

    assert.equal(snapshot.text.length, 320_000);
    assert.doesNotMatch(snapshot.text, /SHOULD_NOT_BE_CAPTURED/);
  } finally {
    globalThis.document = previousDocument;
    globalThis.location = previousLocation;
  }
});

function fakeElement(textContent, excludedNodes = [], breakNodes = []) {
  return {
    textContent,
    cloneNode() {
      return {
        textContent,
        querySelectorAll(selector) {
          return selector.includes("script") ? excludedNodes : breakNodes;
        }
      };
    }
  };
}
