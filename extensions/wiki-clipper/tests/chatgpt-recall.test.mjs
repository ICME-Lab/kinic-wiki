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

test("ChatGPT recall listener ignores IME composition Enter keys", async () => {
  const composer = textarea("こんにちは");
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

  listeners.get("keydown")({ key: "Enter", shiftKey: false, isComposing: true, target: composer });
  listeners.get("keydown")({ key: "Enter", shiftKey: false, keyCode: 229, target: composer });
  await new Promise((resolve) => setTimeout(resolve, 340));
  assert.deepEqual(received, []);

  listeners.get("keydown")({ key: "Enter", shiftKey: false, target: composer });
  await new Promise((resolve) => setTimeout(resolve, 340));
  assert.deepEqual(received, ["こんにちは"]);
  cleanup();
});

test("ChatGPT navigation listener detects URL changes via DOM mutations and events", () => {
  const listeners = new Map();
  const location = { href: "https://chatgpt.com/c/one" };
  const windowRef = {
    location,
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type) {
      listeners.delete(type);
    }
  };
  let observerCallback = null;
  let disconnected = 0;
  let observed = null;
  class FakeMutationObserver {
    constructor(callback) {
      observerCallback = callback;
    }
    observe(target, options) {
      observed = { target, options };
    }
    disconnect() {
      disconnected += 1;
    }
  }
  const documentRef = { documentElement: {} };
  const navigations = [];
  const dispose = installChatGptNavigationListener({
    windowRef,
    locationLike: location,
    documentRef,
    MutationObserverRef: FakeMutationObserver,
    onNavigate: (url) => navigations.push(url)
  });

  assert.deepEqual(observed, { target: documentRef.documentElement, options: { childList: true, subtree: true } });

  location.href = "https://chatgpt.com/c/two";
  observerCallback();
  assert.deepEqual(navigations, ["https://chatgpt.com/c/two"]);

  location.href = "https://chatgpt.com/c/three";
  listeners.get("hashchange")();
  assert.deepEqual(navigations, ["https://chatgpt.com/c/two", "https://chatgpt.com/c/three"]);

  listeners.get("popstate")();
  assert.deepEqual(navigations, ["https://chatgpt.com/c/two", "https://chatgpt.com/c/three"]);

  dispose();
  assert.equal(disconnected, 1);
  assert.equal(listeners.has("popstate"), false);
  assert.equal(listeners.has("hashchange"), false);
});

test("ChatGPT navigation listener falls back to events without a document", () => {
  const listeners = new Map();
  const location = { href: "https://chatgpt.com/c/one" };
  const windowRef = {
    location,
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener() {}
  };
  const navigations = [];
  const dispose = installChatGptNavigationListener({
    windowRef,
    locationLike: location,
    onNavigate: (url) => navigations.push(url)
  });

  location.href = "https://chatgpt.com/c/two";
  listeners.get("popstate")();
  assert.deepEqual(navigations, ["https://chatgpt.com/c/two"]);
  dispose();
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
