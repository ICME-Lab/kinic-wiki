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

test("messagesFromMapping removes ChatGPT citation markers without changing order or roles", () => {
  const mapping = {
    root: node(null, null),
    user1: node("root", message("user", "Explain SDF")),
    assistant1: node(
      "user1",
      message(
        "assistant",
        `SDF is a distance function.${citation("turn429397search0", "turn429397search24")}\n\nRaymarching advances until a surface is hit.`
      )
    ),
    user2: node("assistant1", message("user", "More")),
    assistant2: node(
      "user2",
      message(
        "assistant",
        `First source ${citation("turn429397search16")} and second source ${citation("turn429397search25")} remain text only.`
      )
    )
  };

  assert.deepEqual(messagesFromMapping(mapping, "assistant2"), [
    { role: "user", content: "Explain SDF" },
    { role: "assistant", content: "SDF is a distance function.\n\nRaymarching advances until a surface is hit." },
    { role: "user", content: "More" },
    { role: "assistant", content: "First source  and second source  remain text only." }
  ]);
});

test("messagesFromMapping caps captured content before later huge messages", () => {
  const mapping = {
    root: node(null, null),
    user1: node("root", message("user", "a".repeat(400_000))),
    assistant1: node("user1", message("assistant", "SHOULD_NOT_BE_CAPTURED"))
  };

  const messages = messagesFromMapping(mapping, "assistant1");

  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, "user");
  assert.equal(messages[0].content.length, 320_000);
  assert.doesNotMatch(messages.map((entry) => entry.content).join("\n"), /SHOULD_NOT_BE_CAPTURED/);
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

function citation(...refs) {
  return `\uE200cite${refs.map((ref) => `\uE202${ref}`).join("")}\uE201`;
}
