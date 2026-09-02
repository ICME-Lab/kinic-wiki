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

  assert.match(raw.path, /^\/Sources\/web\/example-post-[a-f0-9]{8}\.md$/);
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

test("buildWebEvidenceSource path includes title and url hash", async () => {
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

  assert.notEqual(first.path, second.path);
  assert.match(first.path, /^\/Sources\/web\/日本語-path-bad-title-x-end-[a-f0-9]{8}\.md$/);
  assert.match(second.path, /^\/Sources\/web\/example.com-[a-f0-9]{8}\.md$/);
});

test("webSourcePathForUrl ignores hash fragments", async () => {
  assert.equal(
    await webSourcePathForUrl("https://example.com/post#section", "Example Post"),
    await webSourcePathForUrl("https://example.com/post", "Example Post")
  );
});

test("webSourcePathForUrl distinguishes hash routes", async () => {
  assert.notEqual(
    await webSourcePathForUrl("https://example.com/#/page-a", "Example App"),
    await webSourcePathForUrl("https://example.com/#/page-b", "Example App")
  );
  assert.notEqual(
    await webSourcePathForUrl("https://example.com/#!/page-a", "Example App"),
    await webSourcePathForUrl("https://example.com/#!/page-b", "Example App")
  );
});

test("buildWebEvidenceSource preserves unicode title slugs", async () => {
  const raw = await buildWebEvidenceSource({
    url: "https://example.com/unicode",
    title: "会議 メモ",
    text: "Body"
  });

  assert.match(raw.path, /^\/Sources\/web\/会議-メモ-[a-f0-9]{8}\.md$/);
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

test("collectWebPageSnapshot renders preformatted text as markdown code blocks", () => {
  const previousDocument = globalThis.document;
  const previousLocation = globalThis.location;
  try {
    const article = fakeDomElement("article", [
      fakeDomElement("p", [fakeText("Intro.")]),
      fakeDomElement("pre", [fakeText("const x = 1;\n  console.log(x);")]),
      fakeDomElement("p", [fakeText("After.")])
    ]);
    globalThis.document = {
      title: "Code",
      body: article,
      querySelectorAll(selector) {
        return selector === "article,main,[role='main']" ? [article] : [];
      }
    };
    globalThis.location = { href: "https://example.com/code" };

    const snapshot = collectWebPageSnapshot();

    assert.equal(snapshot.text, "Intro.\n\n```\nconst x = 1;\n  console.log(x);\n```\n\nAfter.");
  } finally {
    globalThis.document = previousDocument;
    globalThis.location = previousLocation;
  }
});

test("collectWebPageSnapshot preserves language and tilde fenced code blocks", () => {
  const previousDocument = globalThis.document;
  const previousLocation = globalThis.location;
  try {
    const article = fakeElement(
      [
        "Intro.",
        "",
        "```python",
        "if True:",
        "    print('kept')",
        "```",
        "",
        "~~~ts",
        "const value = 1;",
        "  console.log(value);",
        "~~~",
        "",
        "After   text."
      ].join("\n"),
      [],
      []
    );
    globalThis.document = {
      title: "Code",
      body: article,
      querySelectorAll(selector) {
        return selector === "article,main,[role='main']" ? [article] : [];
      }
    };
    globalThis.location = { href: "https://example.com/code" };

    const snapshot = collectWebPageSnapshot();

    assert.equal(
      snapshot.text,
      "Intro.\n\n```python\nif True:\n    print('kept')\n```\n\n~~~ts\nconst value = 1;\n  console.log(value);\n~~~\n\nAfter text."
    );
  } finally {
    globalThis.document = previousDocument;
    globalThis.location = previousLocation;
  }
});

test("collectWebPageSnapshot uses a longer fence for code containing backticks", () => {
  const previousDocument = globalThis.document;
  const previousLocation = globalThis.location;
  try {
    const article = fakeDomElement("article", [
      fakeDomElement("pre", [fakeText("```\ninner\n```")])
    ]);
    globalThis.document = {
      title: "Code",
      body: article,
      querySelectorAll(selector) {
        return selector === "article,main,[role='main']" ? [article] : [];
      }
    };
    globalThis.location = { href: "https://example.com/code" };

    const snapshot = collectWebPageSnapshot();

    assert.equal(snapshot.text, "````\n```\ninner\n```\n````");
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

test("collectWebPageSnapshot is self-contained for executeScript serialization", () => {
  const source = collectWebPageSnapshot.toString();
  const referencedHelpers = [
    "normalizeExtractedLine",
    "openingFenceForLine",
    "closingFenceForLine",
    "markdownFence",
    "collapseBlankLines",
    "markdownCodeBlock"
  ];
  for (const helper of referencedHelpers) {
    assert.equal(
      source.includes(helper),
      true,
      `collectWebPageSnapshot must define ${helper} inside its body for chrome.scripting.executeScript serialization`
    );
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

function fakeText(nodeValue) {
  return { nodeType: 3, nodeValue };
}

function fakeDomElement(tagName, childNodes) {
  return {
    nodeType: 1,
    childNodes,
    get textContent() {
      return childNodes.map((child) => child.textContent ?? child.nodeValue ?? "").join("");
    },
    matches(selector) {
      return selector.split(",").some((part) => part.trim().toLowerCase() === tagName);
    }
  };
}
