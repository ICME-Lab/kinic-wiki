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

test("ChatGPT composer inserts into a contenteditable via paste so the editor model stays in sync", () => {
  const composer = contenteditable("What did I save about MCP?");
  const documentRef = fakeDocument(composer);
  assert.equal(insertChatGptContext("[Kinic memory]\nMCP notes\n[/Kinic memory]", documentRef), true);
  assert.match(composer.textContent, /What did I save about MCP\?/);
  assert.match(composer.textContent, /\[Kinic memory\]/);
  assert.equal(composer.pasteEvents, 1);
  assert.equal(composer.inputEvents, 0);
});

test("ChatGPT composer falls back to direct text when paste is unsupported", () => {
  const composer = contenteditable("existing");
  composer.ownerDocument.defaultView = { DataTransfer: undefined, ClipboardEvent: undefined };
  const documentRef = fakeDocument(composer);
  assert.equal(insertChatGptContext("block", documentRef), true);
  assert.match(composer.textContent, /existing/);
  assert.match(composer.textContent, /block/);
  assert.equal(composer.inputEvents, 1);
});

test("ChatGPT composer treats an editor-ignored paste as failure without corrupting content", () => {
  const composer = contenteditable("existing");
  composer.dispatchEvent = (event) => {
    if (event.type === "paste" && event.clipboardData) {
      composer.pasteEvents += 1;
      return false;
    }
    if (event.type === "input") composer.inputEvents += 1;
    return true;
  };
  const documentRef = fakeDocument(composer);
  assert.equal(insertChatGptContext("block", documentRef), false);
  assert.equal(composer.textContent, "existing");
  assert.equal(composer.pasteEvents, 1);
  assert.equal(composer.inputEvents, 0);
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
  cleanup.dispose();
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
  cleanup.dispose();
});

test("ChatGPT recall listener ignores Enter and submits from unrelated inputs and forms", async () => {
  const harness = recallHarness();
  const listeners = new Map();
  harness.documentRef.addEventListener = (type, listener) => listeners.set(type, listener);
  harness.documentRef.removeEventListener = () => {};
  const received = [];
  const cleanup = installChatGptRecallListeners({
    documentRef: harness.documentRef,
    locationLike: { href: "https://chatgpt.com/c/abc" },
    onSubmit: (query) => received.push(query)
  });

  listeners.get("keydown")({ key: "Enter", shiftKey: false, target: harness.otherTextarea });
  listeners.get("submit")({ target: harness.otherForm });
  listeners.get("click")({ target: harness.otherButton });
  await new Promise((resolve) => setTimeout(resolve, 340));
  assert.deepEqual(received, [], "unrelated input, form, and send button must not schedule recall");

  listeners.get("submit")({ target: harness.composerForm });
  await new Promise((resolve) => setTimeout(resolve, 340));
  assert.deepEqual(received, ["Find my old agent notes"]);
  cleanup.dispose();
});

test("ChatGPT recall listener accepts only the composer form send button", async () => {
  const harness = recallHarness();
  const listeners = new Map();
  harness.documentRef.addEventListener = (type, listener) => listeners.set(type, listener);
  harness.documentRef.removeEventListener = () => {};
  const received = [];
  const cleanup = installChatGptRecallListeners({
    documentRef: harness.documentRef,
    locationLike: { href: "https://chatgpt.com/c/abc" },
    onSubmit: (query) => received.push(query)
  });

  listeners.get("click")({ target: harness.sendButton });
  await new Promise((resolve) => setTimeout(resolve, 340));
  assert.deepEqual(received, ["Find my old agent notes"]);
  cleanup.dispose();
});

test("ChatGPT recall listener ignores defaultPrevented events", async () => {
  const harness = recallHarness();
  const listeners = new Map();
  harness.documentRef.addEventListener = (type, listener) => listeners.set(type, listener);
  harness.documentRef.removeEventListener = () => {};
  const received = [];
  const cleanup = installChatGptRecallListeners({
    documentRef: harness.documentRef,
    locationLike: { href: "https://chatgpt.com/c/abc" },
    onSubmit: (query) => received.push(query)
  });

  listeners.get("keydown")({ key: "Enter", shiftKey: false, target: harness.composer, defaultPrevented: true });
  listeners.get("submit")({ target: harness.composerForm, defaultPrevented: true });
  listeners.get("click")({ target: harness.sendButton, defaultPrevented: true });
  await new Promise((resolve) => setTimeout(resolve, 340));
  assert.deepEqual(received, []);
  cleanup.dispose();
});

test("ChatGPT recall listener cancels a pending schedule on navigation", async () => {
  const harness = recallHarness();
  const listeners = new Map();
  harness.documentRef.addEventListener = (type, listener) => listeners.set(type, listener);
  harness.documentRef.removeEventListener = () => {};
  const received = [];
  const cleanup = installChatGptRecallListeners({
    documentRef: harness.documentRef,
    locationLike: { href: "https://chatgpt.com/c/abc" },
    onSubmit: (query) => received.push(query)
  });

  listeners.get("keydown")({ key: "Enter", shiftKey: false, target: harness.composer });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(received, []);
  cleanup.cancelPending();
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.deepEqual(received, [], "cancelPending must suppress the scheduled recall");
  cleanup.dispose();
});

function recallHarness() {
  const composerForm = { tag: "form", name: "composer-form" };
  const otherForm = { tag: "form", name: "other-form" };
  const composer = {
    ...textarea("Find my old agent notes"),
    closest: (selector) => (selector === "form" ? composerForm : null),
    contains: () => false
  };
  const otherTextarea = {
    ...textarea("unrelated draft"),
    closest: (selector) => (selector === "form" ? otherForm : null),
    contains: () => false
  };
  const sendButton = makeButton("Send message", composerForm);
  const otherButton = makeButton("Send feedback", otherForm);
  const elements = [composer, otherTextarea, sendButton, otherButton];
  const documentRef = {
    activeElement: composer,
    documentElement: { contains: (element) => elements.includes(element) },
    querySelectorAll: () => [composer, otherTextarea],
    defaultView: { getComputedStyle: () => ({ display: "block", visibility: "visible" }) },
    addEventListener() {},
    removeEventListener() {}
  };
  return { composer, otherTextarea, sendButton, otherButton, composerForm, otherForm, documentRef };
}

function makeButton(ariaLabel, form) {
  const button = {
    disabled: false,
    ownerDocument: { defaultView: { getComputedStyle: () => ({ display: "block", visibility: "visible" }) } },
    getAttribute: (name) => (name === "aria-label" ? ariaLabel : ""),
    closest: (selector) => (selector === "button" ? button : selector === "form" ? form : null),
    contains: () => false
  };
  return button;
}

test("ChatGPT navigation listener detects URL changes via DOM mutations and events", () => {
  const listeners = new Map();
  const location = { href: "https://chatgpt.com/c/one" };
  const originalPushState = () => {};
  const originalReplaceState = () => {};
  const windowRef = {
    location,
    history: {
      pushState: originalPushState,
      replaceState: originalReplaceState
    },
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

  location.href = "https://chatgpt.com/c/four";
  windowRef.history.pushState({}, "", "https://chatgpt.com/c/four");
  assert.deepEqual(navigations, ["https://chatgpt.com/c/two", "https://chatgpt.com/c/three", "https://chatgpt.com/c/four"]);

  location.href = "https://chatgpt.com/c/five";
  windowRef.history.replaceState({}, "", "https://chatgpt.com/c/five");
  assert.deepEqual(navigations, ["https://chatgpt.com/c/two", "https://chatgpt.com/c/three", "https://chatgpt.com/c/four", "https://chatgpt.com/c/five"]);

  dispose();
  assert.equal(disconnected, 1);
  assert.equal(windowRef.history.pushState, originalPushState);
  assert.equal(windowRef.history.replaceState, originalReplaceState);
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

test("ChatGPT navigation listener keeps the history wrapper until the last install disposes", () => {
  const listeners = new Map();
  const location = { href: "https://chatgpt.com/c/one" };
  const originalPushState = () => {};
  const windowRef = {
    location,
    history: { pushState: originalPushState },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener() {}
  };
  const first = [];
  const second = [];
  const disposeA = installChatGptNavigationListener({
    windowRef,
    locationLike: location,
    onNavigate: (url) => first.push(url)
  });
  const disposeB = installChatGptNavigationListener({
    windowRef,
    locationLike: location,
    onNavigate: (url) => second.push(url)
  });

  location.href = "https://chatgpt.com/c/two";
  windowRef.history.pushState({}, "", "https://chatgpt.com/c/two");
  assert.deepEqual(first, ["https://chatgpt.com/c/two"]);
  assert.deepEqual(second, ["https://chatgpt.com/c/two"]);

  disposeA();
  location.href = "https://chatgpt.com/c/three";
  windowRef.history.pushState({}, "", "https://chatgpt.com/c/three");
  assert.deepEqual(second, ["https://chatgpt.com/c/two", "https://chatgpt.com/c/three"]);
  assert.notEqual(windowRef.history.pushState, originalPushState);

  disposeB();
  assert.equal(windowRef.history.pushState, originalPushState);
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

function contenteditable(value) {
  const element = {
    textContent: value,
    disabled: false,
    inputEvents: 0,
    pasteEvents: 0,
    ownerDocument: { defaultView: fakeEditorView() },
    getAttribute: () => "",
    matches: (selector) => selector.includes("[contenteditable='true']"),
    contains: () => false,
    focus() {},
    dispatchEvent(event) {
      if (event.type === "paste" && event.clipboardData) {
        this.pasteEvents += 1;
        const pasted = event.clipboardData.getData("text/plain");
        if (pasted) this.textContent = this.textContent ? `${this.textContent}\n\n${pasted}` : pasted;
        return false;
      }
      if (event.type === "input") this.inputEvents += 1;
      return true;
    }
  };
  return element;
}

function fakeEditorView() {
  class DataTransfer {
    constructor() {
      this.data = new Map();
    }
    setData(type, value) {
      this.data.set(type, value);
    }
    getData(type) {
      return this.data.get(type) || "";
    }
  }
  class ClipboardEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.clipboardData = init.clipboardData || null;
      this.cancelable = init.cancelable;
    }
  }
  return { DataTransfer, ClipboardEvent };
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
