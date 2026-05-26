// Where: extensions/wiki-clipper/tests/claude-response.test.mjs
// What: Unit tests for Claude private API export conversion.
// Why: Claude export depends on signed-in claude.ai page state and private response shapes.
import assert from "node:assert/strict";
import test from "node:test";
import {
  captureFromClaudeResponse,
  claudeConversationIdFromUrl,
  collectClaudeConversationTargets,
  fetchClaudeConversationCapture,
  messagesFromClaudePayload,
  resolveClaudeOrganizationId
} from "../src/claude-response.js";

const ORG_ID = "12345678-1234-1234-1234-123456789abc";

test("resolveClaudeOrganizationId reads resource URLs before localStorage", () => {
  const performanceObject = {
    getEntriesByType() {
      return [{ name: `https://claude.ai/api/organizations/${ORG_ID}/chat_conversations/abc` }];
    }
  };
  const storage = memoryStorage({ organization_uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" });

  assert.equal(resolveClaudeOrganizationId(performanceObject, storage), ORG_ID);
});

test("resolveClaudeOrganizationId reads known and JSON localStorage keys", () => {
  assert.equal(
    resolveClaudeOrganizationId(emptyPerformance(), memoryStorage({ organization_uuid: ORG_ID })),
    ORG_ID
  );
  assert.equal(
    resolveClaudeOrganizationId(emptyPerformance(), memoryStorage({ some_org_key: JSON.stringify({ organizationUuid: ORG_ID }) })),
    ORG_ID
  );
});

test("collectClaudeConversationTargets extracts sidebar links with dedupe and limit", () => {
  const doc = fakeDocument([
    link("/chat/one", "One"),
    link("https://claude.ai/chat/two", "Two"),
    link("/chat/one", "One duplicate")
  ]);
  const targets = collectClaudeConversationTargets(2, doc, { origin: "https://claude.ai", href: "https://claude.ai/new" });

  assert.deepEqual(
    targets.map((target) => [target.id, target.title, target.url]),
    [
      ["one", "One", "https://claude.ai/chat/one"],
      ["two", "Two", "https://claude.ai/chat/two"]
    ]
  );
});

test("collectClaudeConversationTargets includes current conversation first", () => {
  const doc = fakeDocument([link("/chat/other", "Other")], "Current Title");
  const targets = collectClaudeConversationTargets(2, doc, { origin: "https://claude.ai", href: "https://claude.ai/chat/current" });

  assert.deepEqual(
    targets.map((target) => [target.id, target.title]),
    [
      ["current", "Current Title"],
      ["other", "Other"]
    ]
  );
});

test("messagesFromClaudePayload maps text, content arrays, and attachments", () => {
  const messages = messagesFromClaudePayload({
    chat: {
      chat_messages: [
        { uuid: "u1", sender: "human", text: "Hello" },
        { uuid: "a1", sender: "assistant", content: [{ text: "Hi" }, { content: "More" }] },
        { uuid: "u2", sender: "human", attachments: [{ extracted_content: "File text" }] },
        { uuid: "s1", sender: "system", text: "" }
      ]
    }
  });

  assert.deepEqual(messages, [
    { role: "user", content: "Hello" },
    { role: "assistant", content: "Hi\n\nMore" },
    { role: "user", content: "File text" }
  ]);
});

test("captureFromClaudeResponse emits Claude capture", () => {
  const capture = captureFromClaudeResponse(
    {
      chat: {
        name: "Claude Project",
        chat_messages: [{ sender: "human", text: "Hello" }]
      }
    },
    "https://claude.ai/chat/abc",
    "Fallback",
    "2026-05-01T00:00:00.000Z"
  );

  assert.equal(capture.provider, "claude");
  assert.equal(capture.conversationTitle, "Claude Project");
  assert.equal(capture.capturedAt, "2026-05-01T00:00:00.000Z");
  assert.deepEqual(capture.messages, [{ role: "user", content: "Hello" }]);
});

test("fetchClaudeConversationCapture uses private API and reports failures without saving", async () => {
  const target = { id: "abc", title: "Project", url: "https://claude.ai/chat/abc", organizationId: ORG_ID };
  const ok = await fetchClaudeConversationCapture(target, async (url, init) => {
    assert.equal(
      url,
      `https://claude.ai/api/organizations/${ORG_ID}/chat_conversations/abc?tree=True&rendering_mode=messages&render_all_tools=true&consistency=strong`
    );
    assert.equal(init.credentials, "include");
    return jsonResponse({
      chat: {
        name: "Project",
        chat_messages: [{ sender: "human", text: "Hello" }]
      }
    });
  });
  const failed = await fetchClaudeConversationCapture(target, async () => jsonResponse({}, false, 500));

  assert.equal(ok.ok, true);
  assert.equal(ok.capture.captureMethod, "claude private api");
  assert.equal(failed.ok, false);
  assert.match(failed.error, /Claude API failed: 500/);
});

test("claudeConversationIdFromUrl accepts only Claude chat paths", () => {
  const loc = { origin: "https://claude.ai" };
  assert.equal(claudeConversationIdFromUrl("/chat/abc", loc), "abc");
  assert.equal(claudeConversationIdFromUrl("/new", loc), "");
});

function jsonResponse(payload, ok = true, status = 200) {
  return {
    ok,
    status,
    async json() {
      return payload;
    }
  };
}

function emptyPerformance() {
  return { getEntriesByType: () => [] };
}

function memoryStorage(values) {
  const entries = Object.entries(values);
  return {
    length: entries.length,
    key(index) {
      return entries[index]?.[0] ?? null;
    },
    getItem(key) {
      return values[key] ?? null;
    }
  };
}

function link(href, text) {
  return {
    href,
    textContent: text,
    getAttribute(name) {
      if (name === "href") return href;
      if (name === "title") return text;
      return null;
    }
  };
}

function fakeDocument(links, title = "") {
  return {
    title,
    querySelectorAll(selector) {
      return selector.includes('a[href*="/chat/"]') ? links : [];
    }
  };
}
