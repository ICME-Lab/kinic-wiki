// Where: workers/wiki-generator/tests/recall-search.test.ts
// What: Recall search candidate retrieval, rerank, and fallback behavior.
// Why: Search precision depends on LLM rerank over lexical candidates, with a safe
//      lexical fallback when the LLM call fails.
import assert from "node:assert/strict";
import test from "node:test";
import { fnv1aHex } from "@kinic/source-contracts";
import { parseRecallSearchInput, runRecallSearch, type RecallSearchOutcome } from "../src/recall-search.js";
import type { SearchNodeHit } from "../src/types.js";
import { testEnv, TestQueue } from "./source-capture-fixtures.js";

function hit(path: string, previewExcerpt: string | null = null): SearchNodeHit {
  return { path, kind: "file", snippet: null, previewExcerpt };
}

const CONFIGURED_CANISTER_ID = "6emaw-iyaaa-aaaay-aacka-cai";

function env() {
  return testEnv(new TestQueue());
}

async function withDeepSeek(body: unknown, run: () => Promise<unknown>): Promise<void> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (): Promise<Response> =>
    new Response(JSON.stringify({ choices: [{ message: { content: typeof body === "string" ? body : JSON.stringify(body) } }] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("parseRecallSearchInput accepts a valid input", () => {
  const parsed = parseRecallSearchInput({
    draft: "draft text",
    distilledQuery: "長期記憶 設計",
    canisterId: CONFIGURED_CANISTER_ID,
    databaseId: "db_1"
  });
  assert.deepEqual(parsed, {
    draft: "draft text",
    distilledQuery: "長期記憶 設計",
    canisterId: CONFIGURED_CANISTER_ID,
    databaseId: "db_1",
    conversationUrl: undefined
  });
});

test("parseRecallSearchInput rejects missing or oversized fields", () => {
  assert.equal(typeof parseRecallSearchInput(null), "string");
  assert.equal(typeof parseRecallSearchInput({}), "string");
  assert.equal(typeof parseRecallSearchInput({ draft: "x", distilledQuery: "y", canisterId: "c", databaseId: "" }), "string");
  assert.equal(typeof parseRecallSearchInput({ draft: "x", distilledQuery: "y", canisterId: "c", databaseId: "d".repeat(200) }), "string");
});

test("runRecallSearch reranks candidates in LLM order", async () => {
  const searchNodes = async (_databaseId: string, _query: string, _limit: number, prefix: string) =>
    prefix === "/Knowledge"
      ? [hit("/Knowledge/one.md", "one body"), hit("/Knowledge/two.md", "two body"), hit("/Knowledge/four.md", "four body")]
      : [hit("/Sources/three.md", "three body")];
  const reranked = {
    results: [
      { path: "/Knowledge/two.md", reason: "matches intent" },
      { path: "/Knowledge/one.md", reason: "also relevant" },
      { path: "/Sources/three.md", reason: "source" }
    ]
  };
  let outcome: RecallSearchOutcome | undefined;
  await withDeepSeek(reranked, async () => {
    outcome = await runRecallSearch(env(), {
      draft: "how do agents keep long-term memory",
      distilledQuery: "長期記憶 設計",
      canisterId: CONFIGURED_CANISTER_ID,
      databaseId: "db_1"
    }, { searchNodes });
  });
  assert.ok(outcome);
  assert.equal(outcome.mode, "reranked");
  assert.deepEqual(outcome.results.map((result) => result.path), ["/Knowledge/two.md", "/Knowledge/one.md", "/Sources/three.md"]);
});

test("runRecallSearch ignores LLM paths that are not candidates", async () => {
  const searchNodes = async (_databaseId: string, _query: string, _limit: number, prefix: string) =>
    prefix === "/Knowledge" ? [hit("/Knowledge/one.md", "one body")] : [];
  const reranked = {
    results: [
      { path: "/Knowledge/one.md", reason: "relevant" },
      { path: "/Knowledge/fabricated.md", reason: "invented" }
    ]
  };
  let outcome: RecallSearchOutcome | undefined;
  await withDeepSeek(reranked, async () => {
    outcome = await runRecallSearch(env(), {
      draft: "draft",
      distilledQuery: "one",
      canisterId: CONFIGURED_CANISTER_ID,
      databaseId: "db_1"
    }, { searchNodes });
  });
  assert.ok(outcome);
  assert.equal(outcome.mode, "reranked");
  assert.deepEqual(outcome.results.map((result) => result.path), ["/Knowledge/one.md"]);
});

test("runRecallSearch falls back to lexical top hits when the LLM call fails", async () => {
  const searchNodes = async (_databaseId: string, _query: string, _limit: number, prefix: string) =>
    prefix === "/Knowledge"
      ? [hit("/Knowledge/one.md"), hit("/Knowledge/two.md"), hit("/Knowledge/four.md")]
      : [hit("/Sources/three.md")];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (): Promise<Response> => new Response("boom", { status: 500 });
  try {
    const outcome = await runRecallSearch(env(), {
      draft: "draft",
      distilledQuery: "one two three",
      canisterId: CONFIGURED_CANISTER_ID,
      databaseId: "db_1"
    }, { searchNodes });
    assert.equal(outcome.mode, "lexical");
    assert.deepEqual(outcome.results.map((result) => result.path), ["/Knowledge/one.md", "/Knowledge/two.md", "/Knowledge/four.md"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("runRecallSearch returns empty when no candidates exist", async () => {
  const searchNodes = async () => [];
  const outcome = await runRecallSearch(env(), {
    draft: "draft",
    distilledQuery: "nothing",
    canisterId: CONFIGURED_CANISTER_ID,
    databaseId: "db_1"
  }, { searchNodes });
  assert.deepEqual(outcome, { mode: "lexical", results: [] });
});

test("runRecallSearch excludes the current conversation source path", async () => {
  const conversationId = "abc";
  const currentPath = `/Sources/chatgpt/current-${fnv1aHex(`chatgpt:${conversationId}`)}.md`;
  const searchNodes = async (_databaseId: string, _query: string, _limit: number, prefix: string) =>
    prefix === "/Knowledge" ? [hit("/Knowledge/one.md")] : [hit(currentPath, "current"), hit("/Sources/other.md", "other")];
  const reranked = { results: [{ path: "/Knowledge/one.md", reason: "x" }] };
  let outcome: RecallSearchOutcome | undefined;
  await withDeepSeek(reranked, async () => {
    outcome = await runRecallSearch(env(), {
      draft: "draft",
      distilledQuery: "one",
      canisterId: CONFIGURED_CANISTER_ID,
      databaseId: "db_1",
      conversationUrl: `https://chatgpt.com/c/${conversationId}`
    }, { searchNodes });
  });
  assert.ok(outcome);
  assert.deepEqual(outcome.results.map((result) => result.path), ["/Knowledge/one.md"]);
});

test("runRecallSearch rejects a canisterId mismatch", async () => {
  await assert.rejects(
    runRecallSearch(env(), {
      draft: "draft",
      distilledQuery: "one",
      canisterId: "different-cai",
      databaseId: "db_1"
    }),
    /canisterId does not match/
  );
});
