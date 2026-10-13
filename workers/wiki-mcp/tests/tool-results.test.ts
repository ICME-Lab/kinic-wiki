import { describe, expect, it } from "vitest";
import { clipText } from "../src/text.js";
import { toContextToolResult, toFetchedNodeToolResult, toFetchManyToolResult, toReadPathsToolResult, toToolResult, toolError } from "../src/tool-results.js";

const node = (text: string, extra = "", path = "/page") => ({ id: path, title: path, text, metadata: { path, extra, truncated: false } });
const bytes = (result: unknown) => new TextEncoder().encode(JSON.stringify(result)).length;
const hasUnpairedSurrogate = (text: string) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text);

describe("bounded MCP responses", () => {
  it("keeps untouched NUL, BOM, Japanese and emoji content identical in both representations", () => {
    const text = "\uFEFF日本語\u0000😀";
    const result = toFetchedNodeToolResult(node(text));
    expect(result.structuredContent?.text).toBe(text);
    expect(result.content[0].text).toContain(text);
    expect(result.structuredContent?.metadata).toMatchObject({ truncated: false });
  });
  it("clips every UTF-16 boundary safely", () => {
    for (let budget = 0; budget < 16; budget++) {
      const clipped = clipText("😀".repeat(20), budget);
      expect(clipped.length).toBeLessThanOrEqual(budget);
      expect(hasUnpairedSurrogate(clipped)).toBe(false);
    }
  });
  it.each(["😀", "日本語", "\u0000\n\t\"\\"])("bounds ten pages of %j by serialized UTF-8 bytes", (unit) => {
    const result = toFetchManyToolResult({ results: Array.from({ length: 10 }, (_, i) => node(unit.repeat(40_000), "", `/page${i}`)) });
    expect(result.isError).not.toBe(true);
    expect(bytes(result)).toBeLessThanOrEqual(256_000);
    const results = result.structuredContent?.results as ReturnType<typeof node>[];
    expect(results.reduce((sum, entry) => sum + entry.text.length, 0)).toBeLessThanOrEqual(100_000);
    for (const entry of results) {
      expect(hasUnpairedSurrogate(entry.text)).toBe(false);
      expect(entry.metadata.truncated).toBe(true);
      expect(result.content[0].text).toContain(`Content:\n${entry.text}`);
    }
  });
  it("rejects single-page metadata that cannot fit with an empty body", () => {
    const result = toFetchedNodeToolResult(node("body", "x".repeat(300_000)));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("exceeds serialized limit");
    expect(bytes(result)).toBeLessThanOrEqual(256_000);
  });
  it("preserves surrounding successes and their metadata when an item is oversized", () => {
    const result = toFetchManyToolResult({ results: [node("first", "keep"), node("huge", "x".repeat(300_000), "/huge"), node("last", "keep", "/last")] });
    const results = result.structuredContent?.results as Record<string, unknown>[];
    expect(results[0].text).toBe("first");
    expect(results[0].metadata).toMatchObject({ extra: "keep" });
    expect(results[1]).toMatchObject({ id: "/huge", is_error: true });
    expect(results[2].text).toBe("last");
  });
  it("reduces an oversized existing item error without discarding other results", () => {
    const result = toFetchManyToolResult({ results: [node("body"), { id: "/failed", error: "x".repeat(300_000), is_error: true }] });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent?.results).toMatchObject([{ text: "body" }, { id: "/failed", error: "tool result exceeds serialized limit", is_error: true }]);
    expect(bytes(result)).toBeLessThanOrEqual(256_000);
  });
  it("admits metadata in input order and retains read_paths compatibility metadata", () => {
    const metadata = { row_count: 3, limit: 3, parse_error_count: 0, batch_error: null };
    const result = toReadPathsToolResult({ results: [node("a", "x".repeat(130_000), "/a"), node("b", "x".repeat(130_000), "/b"), node("c", "small", "/c")], metadata });
    const results = result.structuredContent?.results as Record<string, unknown>[];
    expect(results[0].metadata).toMatchObject({ extra: "x".repeat(130_000) });
    expect(results[1]).toMatchObject({ path: "/b", is_error: true });
    expect(results[2].text).toBe("c");
    expect(result.structuredContent?.metadata).toEqual(metadata);
    expect(bytes(result)).toBeLessThanOrEqual(256_000);
  });
  it("returns a fixed short error if mandatory identities alone exceed the limit", () => {
    const result = toFetchManyToolResult({ results: [node("", "", "p".repeat(300_000))] });
    expect(result.isError).toBe(true);
    expect(bytes(result)).toBeLessThan(200);
  });
  it("uses the same bounded context nodes and marks both node and context truncation", () => {
    const result = toContextToolResult({ nodes: [{ node: { text: "😀日本語".repeat(40_000), truncated: false }, score: 1 }], truncated: false });
    const payload = result.structuredContent!;
    const entry = (payload.nodes as Array<{ node: { text: string; truncated: boolean } }>)[0];
    expect(entry.node.truncated).toBe(true);
    expect(payload.truncated).toBe(true);
    expect(hasUnpairedSurrogate(entry.node.text)).toBe(false);
    expect(JSON.parse(result.content[0].text.split("\n\n")[1])).toEqual(payload);
    expect(bytes(result)).toBeLessThanOrEqual(256_000);
  });
  it("rejects context metadata and bounds generic success/error results", () => {
    expect(toContextToolResult({ nodes: [], metadata: "x".repeat(300_000) }).isError).toBe(true);
    expect(toToolResult({ data: "x".repeat(300_000) }).isError).toBe(true);
    const error = toolError("failed", { error: "x".repeat(300_000) });
    expect(bytes(error)).toBeLessThan(200);
    expect(toolError("failed", {}, { auth: "keep" })._meta).toEqual({ auth: "keep" });
  });
});
