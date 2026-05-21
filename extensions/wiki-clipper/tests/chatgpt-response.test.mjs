// Where: extensions/wiki-clipper/tests/chatgpt-response.test.mjs
// What: Unit tests for ChatGPT API response conversion.
// Why: Direct API export depends on mapping/current_node ordering.
import assert from "node:assert/strict";
import test from "node:test";
import { captureFromChatGptResponse, messagesFromMapping } from "../src/chatgpt-response.js";

test("messagesFromMapping follows the current_node parent chain", () => {
  const mapping = {
    root: node(null, null),
    old: node("root", message("assistant", "Older branch")),
    user1: node("root", message("user", "Hello")),
    assistant1: node("user1", message("assistant", "Hi")),
    user2: node("assistant1", message("user", "Next"))
  };

  assert.deepEqual(messagesFromMapping(mapping, "user2"), [
    { role: "user", content: "Hello" },
    { role: "assistant", content: "Hi" },
    { role: "user", content: "Next" }
  ]);
});

test("captureFromChatGptResponse normalizes title, roles, and empty content", () => {
  const capture = captureFromChatGptResponse(
    {
      conversation_id: "abc",
      title: "  Test Chat  ",
      current_node: "assistant2",
      mapping: {
        root: node(null, null),
        user1: node("root", message("user", ["First", "Second"])),
        empty: node("user1", message("assistant", "")),
        assistant2: node("empty", message("tool", "Fallback role"))
      }
    },
    "https://chatgpt.com/c/abc",
    "2026-05-01T00:00:00.000Z"
  );

  assert.equal(capture.conversationTitle, "Test Chat");
  assert.equal(capture.capturedAt, "2026-05-01T00:00:00.000Z");
  assert.deepEqual(capture.messages, [
    { role: "user", content: "First\nSecond" },
    { role: "assistant", content: "Fallback role" }
  ]);
});

function node(parent, messageValue) {
  return { parent, children: [], message: messageValue };
}

function message(role, parts) {
  return {
    id: crypto.randomUUID(),
    author: { role },
    content: { parts: Array.isArray(parts) ? parts : [parts] }
  };
}
