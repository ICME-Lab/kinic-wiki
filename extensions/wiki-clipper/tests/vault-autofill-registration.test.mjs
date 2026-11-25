// Where: extensions/wiki-clipper/tests/vault-autofill-registration.test.mjs
// What: Unit tests for registering the Vault autofill script from optional website access.
// Why: Clipper users who never grant website access must not get a content script on every site.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  AUTOFILL_ORIGINS,
  AUTOFILL_SCRIPT_ID,
  syncAutofillRegistration
} from "../src/vault/autofill-registration.ts";

function fakeChrome(granted) {
  const registered = new Map();
  const calls = [];
  return {
    calls,
    registered,
    permissions: {
      contains: async ({ origins }) => origins.every((origin) => granted.has(origin))
    },
    scripting: {
      getRegisteredContentScripts: async ({ ids }) =>
        ids.filter((id) => registered.has(id)).map((id) => registered.get(id)),
      registerContentScripts: async (scripts) => {
        calls.push("register");
        for (const script of scripts) registered.set(script.id, script);
      },
      updateContentScripts: async (scripts) => {
        calls.push("update");
        for (const script of scripts) registered.set(script.id, script);
      },
      unregisterContentScripts: async ({ ids }) => {
        calls.push("unregister");
        for (const id of ids) registered.delete(id);
      }
    }
  };
}

test("registers nothing without website access", async () => {
  const api = fakeChrome(new Set());
  assert.deepEqual(await syncAutofillRegistration(api), []);
  assert.deepEqual(api.calls, []);
});

test("registers the top-frame script for granted origins only", async () => {
  const api = fakeChrome(new Set(["https://*/*"]));
  assert.deepEqual(await syncAutofillRegistration(api), ["https://*/*"]);
  const script = api.registered.get(AUTOFILL_SCRIPT_ID);
  assert.deepEqual(script.matches, ["https://*/*"]);
  assert.deepEqual(script.js, ["dist/content-autofill.js"]);
  assert.equal(script.allFrames, false);
  assert.deepEqual(api.calls, ["register"]);
  await syncAutofillRegistration(api);
  assert.deepEqual(api.calls, ["register"], "an unchanged grant does not re-register");
});

test("updates matches when the grant changes and unregisters when it is removed", async () => {
  const granted = new Set(["https://*/*"]);
  const api = fakeChrome(granted);
  await syncAutofillRegistration(api);
  granted.add("http://localhost/*");
  await syncAutofillRegistration(api);
  assert.deepEqual(api.registered.get(AUTOFILL_SCRIPT_ID).matches, ["https://*/*", "http://localhost/*"]);
  granted.clear();
  await syncAutofillRegistration(api);
  assert.equal(api.registered.has(AUTOFILL_SCRIPT_ID), false);
  assert.deepEqual(api.calls, ["register", "update", "unregister"]);
});

test("manifest asks for website access only as an optional permission", async () => {
  const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.optional_host_permissions, [...AUTOFILL_ORIGINS]);
  for (const origin of AUTOFILL_ORIGINS) {
    assert.equal(manifest.host_permissions.includes(origin), false, origin);
  }
  const scripts = manifest.content_scripts.flatMap((entry) => entry.js);
  assert.equal(scripts.includes("dist/content-autofill.js"), false);
});
