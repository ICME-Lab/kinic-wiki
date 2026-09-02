// Where: extensions/wiki-clipper/tests/gemini-response.test.mjs
// What: Unit tests for DOM-based Gemini conversation capture.
// Why: Gemini current-chat capture must preserve turn order without relying on private APIs.
import assert from "node:assert/strict";
import test from "node:test";
import {
  captureFromGeminiDom,
  currentGeminiConversationTarget,
  geminiConversationIdFromUrl,
  messagesFromGeminiDom
} from "../src/gemini-response.js";

test("geminiConversationIdFromUrl accepts app and signed-in app paths", () => {
  assert.equal(geminiConversationIdFromUrl("https://gemini.google.com/app/abc"), "abc");
  assert.equal(geminiConversationIdFromUrl("https://gemini.google.com/u/0/app/abc"), "abc");
  assert.equal(geminiConversationIdFromUrl("https://gemini.google.com/app"), "");
});

test("currentGeminiConversationTarget returns the current conversation", () => {
  assert.deepEqual(currentGeminiConversationTarget({
    href: "https://gemini.google.com/u/0/app/abc",
    origin: "https://gemini.google.com"
  }), {
    id: "abc",
    title: "Current conversation",
    url: "https://gemini.google.com/u/0/app/abc"
  });
});

test("messagesFromGeminiDom preserves user and model turn order", () => {
  const elements = [
    fakeElement("user-query", ".query-text", "  First question  "),
    fakeElement("model-response", ".markdown", "First answer\n\nCopy"),
    fakeElement("user-query", ".query-text", "Second question")
  ];
  const messages = messagesFromGeminiDom({
    querySelectorAll(selector) {
      assert.equal(selector, "user-query, model-response");
      return elements;
    }
  });
  assert.deepEqual(messages, [
    { role: "user", content: "First question" },
    { role: "assistant", content: "First answer\n\nCopy" },
    { role: "user", content: "Second question" }
  ]);
});

test("messagesFromGeminiDom caps oversized rendered turns", () => {
  const messages = messagesFromGeminiDom({
    querySelectorAll(selector) {
      assert.equal(selector, "user-query, model-response");
      return [fakeElement("model-response", ".markdown", "x".repeat(210_000))];
    }
  });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, "assistant");
  assert.equal(messages[0].content.length, 200_000);
});

test("messagesFromGeminiDom caps oversized fallback turns", () => {
  const user = fakeElement("user-query", ".query-text", "Question");
  const model = fakeElement("model-response", ".markdown", "x".repeat(210_000));
  const container = {
    querySelector(selector) {
      if (selector.includes("user-query")) return user;
      if (selector.includes("model-response")) return model;
      return null;
    }
  };
  const messages = messagesFromGeminiDom({
    querySelectorAll(selector) {
      if (selector === "user-query, model-response") return [];
      return [container];
    }
  });
  assert.deepEqual(messages, [
    { role: "user", content: "Question" },
    { role: "assistant", content: "x".repeat(200_000 - "Question".length) }
  ]);
});

test("captureFromGeminiDom emits a Gemini evidence capture", () => {
  const capture = captureFromGeminiDom(
    {
      title: "Project | Gemini",
      querySelectorAll() {
        return [fakeElement("user-query", ".query-text", "Question")];
      }
    },
    "https://gemini.google.com/app/abc",
    "2026-05-01T00:00:00.000Z"
  );
  assert.deepEqual(capture, {
    provider: "gemini",
    conversationTitle: "Project",
    url: "https://gemini.google.com/app/abc",
    capturedAt: "2026-05-01T00:00:00.000Z",
    messages: [{ role: "user", content: "Question" }]
  });
});

function fakeElement(tagName, selector, text) {
  return {
    tagName,
    innerText: text,
    textContent: text,
    querySelector(value) {
      return value === selector ? { innerText: text, textContent: text } : null;
    }
  };
}
