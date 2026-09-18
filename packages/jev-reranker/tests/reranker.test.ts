import assert from "node:assert/strict";
import test from "node:test";
import {
  JEV_ENDPOINT,
  JevError,
  rerankWithJev,
  type JevCandidate,
} from "../index.js";

const candidates = (count: number): JevCandidate[] =>
  Array.from({ length: count }, (_, index) => ({
    path: `/Knowledge/private-${index}.md`,
    preview: `secret body ${index}`,
  }));

function response(probabilities: number[], status = 200): Response {
  return new Response(
    JSON.stringify({
      model: "jev-latest",
      answers: Object.fromEntries(
        probabilities.map((noul, index) => [
          `candidate_${index}`,
          { type: "noul", noul },
        ]),
      ),
      usage: { input_tokens: 10, output_tokens: probabilities.length },
    }),
    { status, headers: { "content-type": "application/json" } },
  );
}

test("sends one SystemOne request and selects the top five stably", async () => {
  let requestedUrl = "";
  let requestedBody: unknown;
  const result = await rerankWithJev({
    intent: "search intent",
    candidates: candidates(7),
    apiKey: "private-key",
    workflow: "generator",
    logMetric: () => {},
    fetchImpl: async (input, init) => {
      requestedUrl = String(input);
      requestedBody = JSON.parse(String(init?.body));
      return response([0.2, 0.9, 0.8, 0.8, 0.7, 0.6, 0.1]);
    },
  });
  assert.equal(requestedUrl, JEV_ENDPOINT);
  assert.deepEqual(result.candidates.map(({ path }) => path), [
    "/Knowledge/private-1.md",
    "/Knowledge/private-2.md",
    "/Knowledge/private-3.md",
    "/Knowledge/private-4.md",
    "/Knowledge/private-5.md",
  ]);
  assert.equal(Object.keys((requestedBody as { questions: object }).questions).length, 7);
});

test("caps candidates at twenty", async () => {
  let questionCount = 0;
  await rerankWithJev({
    intent: "x",
    candidates: candidates(25),
    apiKey: "key",
    workflow: "ask_ai",
    logMetric: () => {},
    fetchImpl: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { questions: object };
      questionCount = Object.keys(body.questions).length;
      return response(Array.from({ length: 20 }, (_, index) => index / 20));
    },
  });
  assert.equal(questionCount, 20);
});

test("bypasses the API at five or fewer candidates", async () => {
  let called = false;
  const result = await rerankWithJev({
    intent: "x",
    candidates: candidates(5),
    apiKey: "key",
    workflow: "ask_ai",
    fetchImpl: async () => {
      called = true;
      return response([]);
    },
  });
  assert.equal(called, false);
  assert.equal(result.bypassed, true);
});

for (const status of [429, 529, 500, 503]) {
  test(`classifies HTTP ${status} as retryable`, async () => {
    await assert.rejects(
      rerankWithJev({
        intent: "x",
        candidates: candidates(6),
        apiKey: "key",
        workflow: "generator",
        logMetric: () => {},
        fetchImpl: async () => new Response("failure", { status }),
      }),
      (error: unknown) => error instanceof JevError && error.retryable,
    );
  });
}

for (const status of [401, 403, 422]) {
  test(`classifies HTTP ${status} as permanent`, async () => {
    await assert.rejects(
      rerankWithJev({
        intent: "x",
        candidates: candidates(6),
        apiKey: "key",
        workflow: "generator",
        logMetric: () => {},
        fetchImpl: async () => new Response("failure", { status }),
      }),
      (error: unknown) => error instanceof JevError && !error.retryable,
    );
  });
}

test("classifies incomplete JSON as retryable", async () => {
  await assert.rejects(
    rerankWithJev({
      intent: "x",
      candidates: candidates(6),
      apiKey: "key",
      workflow: "generator",
      logMetric: () => {},
      fetchImpl: async () => new Response('{"answers":'),
    }),
    (error: unknown) => error instanceof JevError && error.code === "jev_incomplete_response" && error.retryable,
  );
});

test("classifies a missing API key as permanent without sending a request", async () => {
  let called = false;
  await assert.rejects(
    rerankWithJev({
      intent: "x",
      candidates: candidates(6),
      apiKey: " ",
      workflow: "generator",
      logMetric: () => {},
      fetchImpl: async () => {
        called = true;
        return response([]);
      },
    }),
    (error: unknown) => error instanceof JevError && error.code === "jev_configuration" && !error.retryable,
  );
  assert.equal(called, false);
});

test("times out and logs no intent, content, path, or key", async () => {
  const logs: string[] = [];
  await assert.rejects(
    rerankWithJev({
      intent: "private question",
      candidates: candidates(6),
      apiKey: "private-key",
      workflow: "ask_ai",
      timeoutMs: 5,
      logMetric: (metric) => logs.push(JSON.stringify(metric)),
      fetchImpl: async (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        }),
    }),
    (error: unknown) => error instanceof JevError && error.code === "jev_timeout",
  );
  const log = logs.join("\n");
  for (const secret of ["private question", "secret body", "/Knowledge", "private-key"])
    assert.equal(log.includes(secret), false);
});

test("classifies a fetch implementation that rejects with the abort reason as a timeout", async () => {
  await assert.rejects(
    rerankWithJev({
      intent: "x",
      candidates: candidates(6),
      apiKey: "key",
      workflow: "ask_ai",
      timeoutMs: 5,
      logMetric: () => {},
      fetchImpl: async (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason),
          );
        }),
    }),
    (error: unknown) =>
      error instanceof JevError &&
      error.code === "jev_timeout" &&
      error.retryable,
  );
});

test("classifies an abort while reading the response body as a timeout", async () => {
  await assert.rejects(
    rerankWithJev({
      intent: "x",
      candidates: candidates(6),
      apiKey: "key",
      workflow: "ask_ai",
      timeoutMs: 5,
      logMetric: () => {},
      fetchImpl: async (_input, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              init?.signal?.addEventListener("abort", () =>
                controller.error(init.signal?.reason),
              );
            },
          }),
        ),
    }),
    (error: unknown) =>
      error instanceof JevError && error.code === "jev_timeout",
  );
});
