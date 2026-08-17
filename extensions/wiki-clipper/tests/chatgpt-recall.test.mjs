// Where: extensions/wiki-clipper/tests/chatgpt-recall.test.mjs
// What: ChatGPT composer detection, submit scheduling, and insertion tests.
// Why: Provider DOM behavior must be isolated from the Recall panel.
import assert from "node:assert/strict";
import test from "node:test";
import {
  findChatGptComposer,
  insertChatGptContext,
  installChatGptNavigationListener,
  installChatGptRecallListeners,
  isChatGptLocation,
  readChatGptComposer
} from "../src/chatgpt-recall.js";

test("ChatGPT composer helpers read and append textarea text", () => {
  const composer = textarea("What did I save about MCP?");
  const documentRef = fakeDocument(composer);
  assert.equal(isChatGptLocation({ href: "https://chatgpt.com/c/abc" }), true);
  assert.equal(findChatGptComposer(documentRef), composer);
  assert.equal(readChatGptComposer(documentRef), "What did I save about MCP?");
  assert.equal(insertChatGptContext("[Kinic memory]\nMCP notes\n[/Kinic memory]", documentRef), true);
  assert.match(composer.value, /What did I save about MCP\?/);
  assert.match(composer.value, /\[Kinic memory\]/);
  assert.equal(composer.inputEvents, 1);
});

test("ChatGPT recall listener ignores typing and schedules submit once", async () => {
  const composer = textarea("Find my old agent notes");
  const documentRef = fakeDocument(composer);
  const listeners = new Map();
  documentRef.addEventListener = (type, listener) => listeners.set(type, listener);
  documentRef.removeEventListener = () => {};
  const received = [];
  const cleanup = installChatGptRecallListeners({
    documentRef,
    locationLike: { href: "https://chatgpt.com/c/abc" },
    onSubmit: (query) => received.push(query)
  });
  listeners.get("input")?.({ target: composer });
  listeners.get("keydown")({ key: "Enter", shiftKey: true, target: composer });
  assert.deepEqual(received, []);
  listeners.get("keydown")({ key: "Enter", shiftKey: false, target: composer });
  await new Promise((resolve) => setTimeout(resolve, 340));
  assert.deepEqual(received, ["Find my old agent notes"]);
  cleanup();
});

test("ChatGPT navigation listener observes history and popstate changes and restores history", () => {
  const listeners = new Map();
  const location = { href: "https://chatgpt.com/c/one" };
  const originalPushState = function () {};
  const originalReplaceState = function () {};
  const history = { pushState: originalPushState, replaceState: originalReplaceState };
  const windowRef = {
    location,
    history,
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type) {
      listeners.delete(type);
    }
  };
  const navigations = [];
  const dispose = installChatGptNavigationListener({
    windowRef,
    locationLike: location,
    onNavigate: (url) => navigations.push(url)
  });

  location.href = "https://chatgpt.com/c/two";
  history.pushState({}, "", "/c/two");
  location.href = "https://chatgpt.com/c/three";
  history.replaceState({}, "", "/c/three");
  location.href = "https://chatgpt.com/c/four";
  listeners.get("popstate")();

  assert.deepEqual(navigations, [
    "https://chatgpt.com/c/two",
    "https://chatgpt.com/c/three",
    "https://chatgpt.com/c/four"
  ]);
  dispose();
  assert.equal(history.pushState, originalPushState);
  assert.equal(history.replaceState, originalReplaceState);
});

function textarea(value) {
  return {
    value,
    disabled: false,
    inputEvents: 0,
    ownerDocument: { defaultView: { getComputedStyle: () => ({ display: "block", visibility: "visible" }) } },
    getAttribute: () => "",
    matches: (selector) => selector.includes("textarea"),
    contains: () => false,
    focus() {},
    setSelectionRange() {},
    dispatchEvent() {
      this.inputEvents += 1;
    }
  };
}

function fakeDocument(composer) {
  return {
    activeElement: composer,
    querySelectorAll: () => [composer],
    addEventListener() {},
    removeEventListener() {},
    defaultView: { getComputedStyle: () => ({ display: "block", visibility: "visible" }) }
  };
}
