import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const wikiBrowser = readFileSync(new URL("../components/wiki-browser.tsx", import.meta.url), "utf8");
const documentPane = readFileSync(new URL("../components/document-pane.tsx", import.meta.url), "utf8");
const urlIngest = readFileSync(new URL("../lib/url-ingest.ts", import.meta.url), "utf8");
const triggerRouteModule = await importTs("../app/api/url-ingest/trigger/route.ts");
const sourceRunRouteModule = await importTs("../app/api/source/run/route.ts");
const queryAnswerRouteModule = await importTs("../app/api/query/answer/route.ts");

assert.doesNotMatch(wikiBrowser, /onLogin=\{login\}[\s\S]{0,140}<TopBar/);
assert.match(wikiBrowser, /authPromptMode\(readIdentity, currentNode\.error \|\| currentChildren\.error\)/);
assert.doesNotMatch(wikiBrowser, /tab === "ingest" \|\| tab === "sources"/);
assert.match(documentPane, /authPrompt\?: "private" \| null/);
assert.doesNotMatch(documentPane, /Write access/);
assert.match(urlIngest, /safeIngestRequestId\(Date\.now\(\), crypto\.randomUUID\(\)\)/);
assert.match(urlIngest, /function isSafeRequestSegment/);
assert.match(urlIngest, /!value\.includes\("\.\."\)/);

await withEnv({}, async () => {
  const response = await triggerRouteModule.POST(triggerRequest("https://wiki.kinic.xyz"));
  assert.equal(response.status, 503);
  assert.match(await response.text(), /KINIC_WIKI_GENERATOR_URL is not configured/);

  const sourceRun = await sourceRunRouteModule.POST(sourceRunRequest("https://wiki.kinic.xyz"));
  assert.equal(sourceRun.status, 503);
  assert.match(await sourceRun.text(), /KINIC_WIKI_GENERATOR_URL is not configured/);
});

await withEnv(
  {
    NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID: "aaaaa-aa",
    KINIC_WIKI_GENERATOR_URL: "https://worker.example",
    KINIC_WIKI_WORKER_TOKEN: "secret-token"
  },
  async () => {
    const forbidden = await triggerRouteModule.POST(triggerRequest("https://evil.example"));
    assert.equal(forbidden.status, 403);

    const preflight = triggerRouteModule.OPTIONS(triggerRequest("chrome-extension://jcfniiflikojmbfnaoamlbbddlikchaj"));
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "chrome-extension://jcfniiflikojmbfnaoamlbbddlikchaj");

    const storePreflight = triggerRouteModule.OPTIONS(triggerRequest("chrome-extension://moebdnadaffhlddnhifmmdoecifhcbdi"));
    assert.equal(storePreflight.status, 204);
    assert.equal(storePreflight.headers.get("access-control-allow-origin"), "chrome-extension://moebdnadaffhlddnhifmmdoecifhcbdi");

    const invalidPath = await triggerRouteModule.POST(
      triggerRequest("https://kinic.xyz", { requestPath: "/Sources/evidence/1.md" })
    );
    assert.equal(invalidPath.status, 400);

    const missingSessionNonce = await triggerRouteModule.POST(
      triggerRequest("https://kinic.xyz", { sessionNonce: "" })
    );
    assert.equal(missingSessionNonce.status, 400);

    const missingCanisterId = await triggerRouteModule.POST(
      triggerRequest("https://kinic.xyz", { canisterId: "" })
    );
    assert.equal(missingCanisterId.status, 400);

    const mismatchedCanisterId = await triggerRouteModule.POST(
      triggerRequest("https://kinic.xyz", { canisterId: "bbbbb-bb" })
    );
    assert.equal(mismatchedCanisterId.status, 400);

    triggerRouteModule.setUrlIngestTriggerDepsForTest({
      checkSession: async () => {
        throw new Error("denied");
      }
    });
    await withMockFetch(async () => {
      throw new Error("worker should not be called");
    }, async () => {
      const response = await triggerRouteModule.POST(triggerRequest("https://wiki.kinic.xyz"));
      assert.equal(response.status, 403);
    });

    triggerRouteModule.setUrlIngestTriggerDepsForTest({
      checkSession: async (canisterId, input) => {
        assert.equal(canisterId, "aaaaa-aa");
        assert.deepEqual(input, {
          canisterId: "aaaaa-aa",
          databaseId: "db_1",
          requestPath: "/Sources/ingest-requests/1.md",
          sessionNonce: "session-1"
        });
      }
    });
    await withMockFetch(async (input, init) => {
      assert.equal(inputUrl(input), "https://worker.example/url-ingest");
      assert.equal(init?.headers?.authorization, "Bearer secret-token");
      assert.equal(init?.method, "POST");
      assert.deepEqual(JSON.parse(init?.body), {
        canisterId: "aaaaa-aa",
        databaseId: "db_1",
        requestPath: "/Sources/ingest-requests/1.md",
        sessionNonce: "session-1"
      });
      return Response.json({ accepted: true }, { status: 202 });
    }, async () => {
      const response = await triggerRouteModule.POST(triggerRequest("https://wiki.kinic.xyz"));
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("access-control-allow-origin"), "https://wiki.kinic.xyz");
    });
    triggerRouteModule.setUrlIngestTriggerDepsForTest();

    const invalidSourcePath = await sourceRunRouteModule.POST(
      sourceRunRequest("https://kinic.xyz", { sourcePath: "/Sources/evidence/web-abc/web-abc.md" })
    );
    assert.equal(invalidSourcePath.status, 400);

    const traversalSourcePath = await sourceRunRouteModule.POST(
      sourceRunRequest("https://kinic.xyz", { sourcePath: "/Sources/evidence/../...md" })
    );
    assert.equal(traversalSourcePath.status, 400);

    const dotdotSourcePath = await sourceRunRouteModule.POST(
      sourceRunRequest("https://kinic.xyz", { sourcePath: "/Sources/evidence/web/a..b.md" })
    );
    assert.equal(dotdotSourcePath.status, 400);

    const missingSourceSessionNonce = await sourceRunRouteModule.POST(
      sourceRunRequest("https://kinic.xyz", { sessionNonce: "" })
    );
    assert.equal(missingSourceSessionNonce.status, 400);

    const missingSourceEtag = await sourceRunRouteModule.POST(
      sourceRunRequest("https://kinic.xyz", { sourceEtag: "" })
    );
    assert.equal(missingSourceEtag.status, 400);

    const sourcePreflight = sourceRunRouteModule.OPTIONS(sourceRunRequest("chrome-extension://moebdnadaffhlddnhifmmdoecifhcbdi"));
    assert.equal(sourcePreflight.status, 204);
    assert.equal(sourcePreflight.headers.get("access-control-allow-origin"), "chrome-extension://moebdnadaffhlddnhifmmdoecifhcbdi");

    sourceRunRouteModule.setSourceRunDepsForTest({
      checkSession: async () => {
        throw new Error("denied");
      }
    });
    await withMockFetch(async () => {
      throw new Error("worker should not be called");
    }, async () => {
      const response = await sourceRunRouteModule.POST(sourceRunRequest("https://wiki.kinic.xyz"));
      assert.equal(response.status, 403);
    });

    sourceRunRouteModule.setSourceRunDepsForTest({
      checkSession: async (canisterId, input) => {
        assert.equal(canisterId, "aaaaa-aa");
        assert.deepEqual(input, {
          databaseId: "db_1",
          sourcePath: "/Sources/evidence/web/abc.md",
          sourceEtag: "etag-source",
          sessionNonce: "session-1"
        });
      }
    });
    await withMockFetch(async (input, init) => {
      assert.equal(inputUrl(input), "https://worker.example/run");
      assert.equal(init?.headers?.authorization, "Bearer secret-token");
      assert.equal(init?.method, "POST");
      assert.deepEqual(JSON.parse(init?.body), {
        databaseId: "db_1",
        sourcePath: "/Sources/evidence/web/abc.md",
        sourceEtag: "etag-source",
        sessionNonce: "session-1",
        dryRun: false
      });
      return Response.json({ queued: true }, { status: 202 });
    }, async () => {
      const response = await sourceRunRouteModule.POST(sourceRunRequest("https://wiki.kinic.xyz"));
      assert.equal(response.status, 202);
      assert.equal(response.headers.get("access-control-allow-origin"), "https://wiki.kinic.xyz");
    });

    await withMockFetch(async () => Response.json({ error: "source etag mismatch" }, { status: 409 }), async () => {
      const response = await sourceRunRouteModule.POST(sourceRunRequest("https://wiki.kinic.xyz"));
      assert.equal(response.status, 409);
      assert.match(await response.text(), /source etag mismatch/);
    });
    sourceRunRouteModule.setSourceRunDepsForTest();
    const sourceRunRoute = readFileSync(new URL("../app/api/source/run/route.ts", import.meta.url), "utf8");
    assert.match(sourceRunRoute, /checkSourceRunSession/);
    assert.doesNotMatch(sourceRunRoute, /checkQueryAnswerSession/);
  }
);

await withEnv({ NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID: "aaaaa-aa" }, async () => {
  const missingKey = await queryAnswerRouteModule.POST(queryAnswerRequest("https://wiki.kinic.xyz"));
  assert.equal(missingKey.status, 503);
  assert.match(await missingKey.text(), /DEEPSEEK_API_KEY is not configured/);
});

await withEnv({ NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID: "aaaaa-aa", DEEPSEEK_API_KEY: "deepseek-key" }, async () => {
  const forbidden = await queryAnswerRouteModule.POST(queryAnswerRequest("https://evil.example"));
  assert.equal(forbidden.status, 403);
  const localForbidden = await queryAnswerRouteModule.POST(queryAnswerRequest("http://localhost:3000"));
  assert.equal(localForbidden.status, 403);

  queryAnswerRouteModule.setQueryAnswerDepsForTest({
    checkSession: async () => ({ principal: "principal-1" }),
    rateLimitStore: rateLimitStore()
  });

  const missingSession = await queryAnswerRouteModule.POST(queryAnswerRequest("https://wiki.kinic.xyz", { sessionNonce: "" }));
  assert.equal(missingSession.status, 403);

  queryAnswerRouteModule.setQueryAnswerDepsForTest({
    checkSession: async () => {
      throw new Error("denied");
    },
    rateLimitStore: rateLimitStore()
  });
  const deniedSession = await queryAnswerRouteModule.POST(queryAnswerRequest("https://wiki.kinic.xyz"));
  assert.equal(deniedSession.status, 403);

  await withMockFetch(async () => {
    throw new Error("DeepSeek should not be called");
  }, async () => {
    const deniedWithoutFetch = await queryAnswerRouteModule.POST(queryAnswerRequest("https://wiki.kinic.xyz"));
    assert.equal(deniedWithoutFetch.status, 403);
  });

  queryAnswerRouteModule.setQueryAnswerDepsForTest({
    checkSession: async () => ({ principal: "principal-1" }),
    rateLimitStore: rateLimitStore(10)
  });
  const limited = await queryAnswerRouteModule.POST(queryAnswerRequest("https://wiki.kinic.xyz"));
  assert.equal(limited.status, 429);

  queryAnswerRouteModule.setQueryAnswerDepsForTest({
    checkSession: async (canisterId, input) => {
      assert.equal(canisterId, "aaaaa-aa");
      assert.deepEqual(input, { databaseId: "db_1", sessionNonce: "session-1" });
      return { principal: "principal-1" };
    },
    rateLimitStore: rateLimitStore()
  });

  const emptyContext = await queryAnswerRouteModule.POST(queryAnswerRequest("https://wiki.kinic.xyz", { context: [] }));
  assert.equal(emptyContext.status, 200);
  assert.equal((await emptyContext.json()).abstained, true);

  const invalidPath = await queryAnswerRouteModule.POST(queryAnswerRequest("https://wiki.kinic.xyz", { selectedPath: "/Private/demo.md" }));
  assert.equal(invalidPath.status, 400);

  const oversizedQuestion = await queryAnswerRouteModule.POST(queryAnswerRequest("https://wiki.kinic.xyz", { question: "x".repeat(1001) }));
  assert.equal(oversizedQuestion.status, 400);

  queryAnswerRouteModule.setQueryAnswerDepsForTest({
    checkSession: async () => ({ principal: "principal-1" }),
    rateLimitStore: rateLimitStore(),
    fetchImpl: async (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      }),
    timeoutMs: 1
  });
  const timeout = await queryAnswerRouteModule.POST(queryAnswerRequest("https://wiki.kinic.xyz"));
  assert.equal(timeout.status, 504);

  queryAnswerRouteModule.setQueryAnswerDepsForTest({
    checkSession: async () => ({ principal: "principal-1" }),
    rateLimitStore: rateLimitStore(),
    fetchImpl: async (input, init) => {
      assert.equal(inputUrl(input), "https://api.deepseek.com/chat/completions");
      const body = JSON.parse(init?.body);
      assert.deepEqual(body.response_format, { type: "json_object" });
      assert.deepEqual(body.thinking, { type: "disabled" });
      const systemPrompt = body.messages.at(0).content;
      assert.match(systemPrompt, /Answer in the user's language/);
      assert.match(systemPrompt, /links are navigation hints, not evidence/);
      assert.match(systemPrompt, /missing or conflicting/);
      assert.match(systemPrompt, /Example JSON/);
      const promptInput = JSON.parse(body.messages.at(-1).content);
      assert.equal(promptInput.question, "What does the wiki say?");
      assert.equal(promptInput.selectedPath, "/Knowledge/demo.md");
      assert.equal(promptInput.databaseId, undefined);
      assert.equal(promptInput.sessionNonce, undefined);
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                answer: "Answer from context.",
                citations: ["/Knowledge/demo.md", "/Knowledge/outside.md"],
                abstained: false
              })
            }
          }
        ]
      });
    }
  });
  const response = await queryAnswerRouteModule.POST(queryAnswerRequest("https://wiki.kinic.xyz"));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body.citations, ["/Knowledge/demo.md"]);
  assert.equal(body.abstained, false);
  queryAnswerRouteModule.setQueryAnswerDepsForTest();
});

console.log("URL security checks OK");

async function importTs(relativePath) {
  const sourcePath = new URL(relativePath, import.meta.url);
  const source = readFileSync(sourcePath, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022
    }
  }).outputText;
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
  return import(moduleUrl);
}

async function withMockFetch(handler, run) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function withEnv(values, run) {
  const keys = ["NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID", "KINIC_WIKI_CANISTER_ID", "KINIC_WIKI_GENERATOR_URL", "KINIC_WIKI_WORKER_TOKEN", "DEEPSEEK_API_KEY", "KINIC_WIKI_WORKER_MODEL"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, values);
  try {
    await run();
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

function triggerRequest(origin, overrides = {}) {
  return new Request("https://local.test/api/url-ingest/trigger", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({
      canisterId: "aaaaa-aa",
      databaseId: "db_1",
      requestPath: "/Sources/ingest-requests/1.md",
      sessionNonce: "session-1",
      ...overrides
    })
  });
}

function sourceRunRequest(origin, overrides = {}) {
  return new Request("https://local.test/api/source/run", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({
      canisterId: "aaaaa-aa",
      databaseId: "db_1",
      sourcePath: "/Sources/evidence/web/abc.md",
      sourceEtag: "etag-source",
      sessionNonce: "session-1",
      ...overrides
    })
  });
}

function queryAnswerRequest(origin, overrides = {}) {
  return new Request("https://local.test/api/query/answer", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({
      question: "What does the wiki say?",
      databaseId: "db_1",
      selectedPath: "/Knowledge/demo.md",
      sessionNonce: "session-1",
      context: [{ path: "/Knowledge/demo.md", title: "Demo", excerpt: "Demo context" }],
      ...overrides
    })
  });
}

function rateLimitStore(initial = 0) {
  let count = initial;
  return {
    async get() {
      return String(count);
    },
    async put(_key, value) {
      count = Number(value);
    }
  };
}

function inputUrl(input) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}
