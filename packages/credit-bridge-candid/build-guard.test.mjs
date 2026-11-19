import { test } from "node:test";
import assert from "node:assert/strict";
import { assertCreditBridgeBuild } from "./build-guard.mjs";
test("production packages reject explicit local origins; only explicitly named test builds permit them", () => {
  assert.throws(() =>
    assertCreditBridgeBuild("build", "production", {
      VITE_CREDIT_BRIDGE_LOCAL_TEST: "1",
    }),
  );
  assert.throws(() =>
    assertCreditBridgeBuild("build", "staging", {
      VITE_CREDIT_BRIDGE_LOCAL_TEST: "1",
    }),
  );
  assert.doesNotThrow(() =>
    assertCreditBridgeBuild("build", "bridge-local-test", {
      VITE_CREDIT_BRIDGE_LOCAL_TEST: "1",
    }),
  );
  assert.doesNotThrow(() => assertCreditBridgeBuild("build", "production", {}));
});
test("build-time pinned override pair cannot leak into production or bypass explicit local mode", () => {
  const pair = {
    VITE_CREDIT_BRIDGE_WIKI_ORIGIN: "http://localhost:3100",
    VITE_CREDIT_BRIDGE_VAULT_ORIGIN:
      "http://rrkah-fqaaa-aaaaa-aaaaq-cai.localhost:44001",
  };
  assert.throws(() => assertCreditBridgeBuild("build", "production", pair));
  assert.throws(() =>
    assertCreditBridgeBuild("serve", "development", {
      ...pair,
      VITE_CREDIT_BRIDGE_LOCAL_TEST: "1",
    }),
  );
  assert.throws(() =>
    assertCreditBridgeBuild("build", "bridge-local-test", pair),
  );
  assert.doesNotThrow(() =>
    assertCreditBridgeBuild("build", "bridge-local-test", {
      ...pair,
      VITE_CREDIT_BRIDGE_LOCAL_TEST: "1",
    }),
  );
  for (const invalid of [
    "https://localhost:3100",
    "http://evil.test",
    "http://localhost:3100/path",
    "http://localhost:3100?target=other",
    "http://localhost:3100#other",
    "http://user@localhost:3100",
    "http://localhost:3100/",
    "http://127.0.0.2:3100",
  ]) {
    assert.throws(() =>
      assertCreditBridgeBuild("build", "bridge-local-test", {
        ...pair,
        VITE_CREDIT_BRIDGE_LOCAL_TEST: "1",
        VITE_CREDIT_BRIDGE_WIKI_ORIGIN: invalid,
      }),
    );
  }
  assert.throws(() =>
    assertCreditBridgeBuild("build", "bridge-local-test", {
      VITE_CREDIT_BRIDGE_LOCAL_TEST: "1",
      VITE_CREDIT_BRIDGE_WIKI_ORIGIN: pair.VITE_CREDIT_BRIDGE_WIKI_ORIGIN,
    }),
  );
});

test("existing runner's exact IPv4 loopback Wiki and canister localhost Vault pair are accepted only in local test mode", () => {
  assert.doesNotThrow(() =>
    assertCreditBridgeBuild("build", "bridge-local-test", {
      VITE_CREDIT_BRIDGE_LOCAL_TEST: "1",
      VITE_CREDIT_BRIDGE_WIKI_ORIGIN: "http://127.0.0.1:3100",
      VITE_CREDIT_BRIDGE_VAULT_ORIGIN:
        "http://rrkah-fqaaa-aaaaa-aaaaq-cai.localhost:44001",
    }),
  );
});
