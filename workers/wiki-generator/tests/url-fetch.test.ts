// Where: workers/wiki-generator/tests/url-fetch.test.ts
// What: URL allowlist tests for browser-submitted ingest requests.
// Why: Worker URL fetch must reject obvious local/private targets before network I/O.
import assert from "node:assert/strict";
import test from "node:test";
import { fetchUrlSource, parseAllowedUrl } from "../src/url-fetch.js";

test("http and https URLs are normalized", () => {
  assert.equal(parseAllowedUrl("https://example.com/a#frag").toString(), "https://example.com/a");
  assert.equal(parseAllowedUrl("http://example.com/").toString(), "http://example.com/");
});

test("non-http and local URLs are rejected", () => {
  assert.throws(() => parseAllowedUrl("ftp://example.com/file"), /http or https/);
  assert.throws(() => parseAllowedUrl("http://localhost:3000"), /not allowed/);
  assert.throws(() => parseAllowedUrl("http://printer.local"), /not allowed/);
  assert.throws(() => parseAllowedUrl("http://127.0.0.1:3000"), /not allowed/);
  assert.throws(() => parseAllowedUrl("http://192.168.0.10"), /not allowed/);
  assert.throws(() => parseAllowedUrl("http://169.254.169.254"), /not allowed/);
  assert.throws(() => parseAllowedUrl("http://[2606:4700:4700::1111]/"), /not allowed/);
});

test("special and reserved IPv4 host forms are rejected after URL normalization", () => {
  for (const url of [
    "http://2130706433/",
    "http://0x7f000001/",
    "http://0177.0.0.1/",
    "http://127.1/",
    "http://0.0.0.0/",
    "http://100.64.0.1/",
    "http://198.18.0.1/",
    "http://192.0.2.1/",
    "http://198.51.100.1/",
    "http://203.0.113.1/",
    "http://224.0.0.1/",
    "http://240.0.0.1/"
  ]) {
    assert.throws(() => parseAllowedUrl(url), /not allowed/);
  }
});

test("safe redirects are followed manually", async () => {
  await withMockFetch(async (input, init) => {
    assert.equal(init?.redirect, "manual");
    const url = inputUrl(input);
    if (url === "https://example.com/start") {
      return new Response(null, { status: 302, headers: { location: "/final#frag" } });
    }
    assert.equal(url, "https://example.com/final");
    return new Response("<title>Done</title><main>Hello</main>", { status: 200, headers: { "content-type": "text/html" } });
  }, async () => {
    const fetched = await fetchUrlSource("https://example.com/start", 10_000);
    assert.equal(fetched.url, "https://example.com/start");
    assert.equal(fetched.finalUrl, "https://example.com/final");
    assert.equal(fetched.title, "Done");
  });
});

test("redirects to blocked hosts are rejected before following", async () => {
  let calls = 0;
  await withMockFetch(async () => {
    calls += 1;
    return new Response(null, { status: 302, headers: { location: "http://127.0.0.1:8000/private" } });
  }, async () => {
    await assert.rejects(() => fetchUrlSource("https://example.com/start", 10_000), /not allowed/);
    assert.equal(calls, 1);
  });
});

test("too many redirects are rejected", async () => {
  await withMockFetch(async () => new Response(null, { status: 302, headers: { location: "/next" } }), async () => {
    await assert.rejects(() => fetchUrlSource("https://example.com/start", 10_000), /too many redirects/);
  });
});

type FetchHandler = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

async function withMockFetch(handler: FetchHandler, run: () => Promise<void>): Promise<void> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function inputUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}
