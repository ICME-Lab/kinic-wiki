import { describe, expect, it, vi } from "vitest";
import { IDL } from "@icp-sdk/core/candid";
import { readIdlFactory } from "@kinic/ii-server/read";
import {
  emptyToolState,
  KinicReader,
  type ReadActor,
  type Node,
} from "../src/kinic";
import {
  DEFAULT_LIMITS,
  isReadablePath,
  parseLimits,
  validateAnswer,
} from "../src/contracts";

export function fixtureActor(): ReadActor {
  const nodes = new Map<string, Node>([
    [
      "/Knowledge/decision.md",
      {
        path: "/Knowledge/decision.md",
        content: "レビュー済み: 本番の色は青。根拠は /Sources/design.md。",
        etag: "v2",
        metadata_json: '{"reviewed":true}',
        updated_at: 100n,
      },
    ],
    [
      "/Sources/design.md",
      {
        path: "/Sources/design.md",
        content: "承認済みの色は青です。",
        etag: "source-1",
        metadata_json: "{}",
        updated_at: 90n,
      },
    ],
  ]);
  return {
    read_node: vi.fn(async (_db: string, path: string) => ({
      Ok: nodes.has(path) ? ([nodes.get(path)!] as [Node]) : ([] as []),
    })),
    memory_manifest: vi.fn(async () => ({
      Ok: {
        api_version: "1",
        recommended_entrypoint: "query_context",
        roots: [{ path: "/Knowledge", kind: "knowledge" }],
      },
    })),
    query_context: vi.fn(async () => ({
      Ok: {
        nodes: [{ node: nodes.get("/Knowledge/decision.md")! }],
        truncated: false,
      },
    })),
    source_evidence: vi.fn(async () => ({
      Ok: {
        node_path: "/Knowledge/decision.md",
        refs: [
          {
            source_path: "/Sources/design.md",
            source_etag: ["source-1"] as [string],
            source_updated_at: [90n] as [bigint],
          },
        ],
      },
    })),
  };
}
describe("read tools and citations", () => {
  it("checks access before the manifest and uses database-scoped manifest arguments", async () => {
    const actor = fixtureActor();
    await new KinicReader(
      actor,
      "db-a",
      "/Knowledge",
      emptyToolState(),
    ).manifest();
    expect(actor.read_node).toHaveBeenCalledWith("db-a", "/Knowledge");
    expect(actor.memory_manifest).toHaveBeenCalledWith({ database_id: "db-a" });
  });
  it("retrieves context, exact node and original source with revision-bound citations", async () => {
    const actor = fixtureActor();
    const state = emptyToolState();
    const reader = new KinicReader(actor, "db-a", "/Knowledge", state);
    await reader.execute("wiki_query", {
      question: "色は？",
      scope: "/Knowledge",
    });
    expect(state.evidence).toHaveLength(0);
    await reader.execute("wiki_read", {
      path: "/Knowledge/decision.md",
      start: 0,
    });
    await reader.execute("wiki_sources", { path: "/Knowledge/decision.md" });
    const source = JSON.parse(
      await reader.execute("wiki_read", {
        path: "/Sources/design.md",
        start: 0,
      }),
    );
    expect(source).toMatchObject({
      databaseId: "db-a",
      etag: "source-1",
      start: 0,
      excerpt: "承認済みの色は青です。",
    });
    const answer = validateAnswer(
      {
        answer: "青です。",
        citations: [{ id: source.id, quote: "色は青" }],
        insufficient: false,
        contradictions: [],
        unverified: [],
      },
      state.evidence,
    );
    expect(answer.citations[0].etag).toBe("source-1");
  });
  it.each([
    "/Skills/run.md",
    "/Sessions/chat.md",
    "/Knowledge/../Skills/run.md",
    "/Knowledge//note.md",
    "https://example.com",
    "/Memory/secret.md",
    "/Sources/design.md",
  ])("rejects undiscovered or out-of-scope path %s", async (path) => {
    const reader = new KinicReader(
      fixtureActor(),
      "db-a",
      "/Knowledge",
      emptyToolState(),
    );
    await expect(
      reader.execute("wiki_read", { path, start: 0 }),
    ).rejects.toThrow("path_not_allowed");
  });
  it("does not accept a model-selected database or scope escalation", async () => {
    const reader = new KinicReader(
      fixtureActor(),
      "db-a",
      "/Knowledge",
      emptyToolState(),
    );
    await expect(
      reader.execute("wiki_query", {
        question: "x",
        scope: "/Knowledge",
        databaseId: "db-b",
      }),
    ).rejects.toThrow();
    await expect(
      reader.execute("wiki_query", { question: "x", scope: "/Memory" }),
    ).rejects.toThrow("scope_not_allowed");
  });
  it("refuses source lookup until the knowledge node has been read", async () => {
    await expect(
      new KinicReader(
        fixtureActor(),
        "db-a",
        "/Knowledge",
        emptyToolState(),
      ).execute("wiki_sources", { path: "/Knowledge/decision.md" }),
    ).rejects.toThrow("read_node_first");
  });
  it("does not leak cross-root graph results", async () => {
    const actor = fixtureActor();
    actor.query_context = vi.fn(async () => ({
      Ok: {
        nodes: [
          {
            node: {
              path: "/Skills/evil.md",
              content: "secret",
              etag: "x",
              metadata_json: "{}",
              updated_at: 0n,
            },
          },
        ],
        truncated: true,
      },
    }));
    const result = await new KinicReader(
      actor,
      "db-a",
      "/Knowledge",
      emptyToolState(),
    ).execute("wiki_query", { question: "x", scope: "/Knowledge" });
    expect(result).not.toContain("secret");
    expect(JSON.parse(result).truncated).toBe(true);
  });
  it("reauthorizes each call and denies revoked access", async () => {
    const actor = fixtureActor();
    const reader = new KinicReader(
      actor,
      "db-a",
      "/Knowledge",
      emptyToolState(),
    );
    await reader.execute("wiki_read", {
      path: "/Knowledge/decision.md",
      start: 0,
    });
    actor.read_node = vi.fn(async () => ({ Err: "forbidden private path" }));
    await expect(
      reader.execute("wiki_sources", { path: "/Knowledge/decision.md" }),
    ).rejects.toThrow("wiki_read_denied");
    expect(actor.source_evidence).not.toHaveBeenCalled();
  });
  it("enforces call and total serialized context budgets", async () => {
    const actor = fixtureActor();
    await expect(
      new KinicReader(actor, "db-a", "/Knowledge", emptyToolState(), 1).execute(
        "wiki_query",
        { question: "x", scope: "/Knowledge" },
      ),
    ).rejects.toThrow("context_limit");
    const reader = new KinicReader(
      actor,
      "db-a",
      "/Knowledge",
      emptyToolState(),
      24000,
      1,
    );
    await reader.execute("wiki_read", {
      path: "/Knowledge/decision.md",
      start: 0,
    });
    await expect(
      reader.execute("wiki_read", { path: "/Knowledge/decision.md", start: 0 }),
    ).rejects.toThrow("tool_limit");
  });
  it("rejects invented citation IDs, altered quotes, and answers without evidence", () => {
    const answer = {
      answer: "青",
      citations: [{ id: "invented", quote: "青" }],
      insufficient: false,
      contradictions: [],
      unverified: [],
    };
    expect(() => validateAnswer(answer, [])).toThrow("invalid_citation");
    expect(() => validateAnswer({ ...answer, citations: [] }, [])).toThrow(
      "unsupported_answer",
    );
    expect(
      validateAnswer({ ...answer, citations: [], insufficient: true }, [])
        .insufficient,
    ).toBe(true);
    expect(() =>
      validateAnswer(answer, [
        {
          id: "invented",
          excerpt: "赤",
          path: "/Knowledge/x",
          databaseId: "a",
          start: 0,
          end: 1,
          etag: "e",
          retrievedAt: "now",
        },
      ]),
    ).toThrow("invalid_citation");
  });
  it("uses only four canister query methods and decodes width-subtyped node records", () => {
    const service = readIdlFactory({ IDL });
    expect(service._fields.map(([name]) => name).sort()).toEqual([
      "memory_manifest",
      "query_context",
      "read_node",
      "source_evidence",
    ]);
    expect(
      service._fields.every(([, method]) =>
        method.annotations.includes("query"),
      ),
    ).toBe(true);
    const fullNode = IDL.Record({
      path: IDL.Text,
      content: IDL.Text,
      etag: IDL.Text,
      metadata_json: IDL.Text,
      updated_at: IDL.Int64,
      extra: IDL.Text,
    });
    const encoded = IDL.encode(
      [IDL.Variant({ Ok: IDL.Opt(fullNode), Err: IDL.Text })],
      [
        {
          Ok: [
            {
              path: "/Knowledge/a",
              content: "hi",
              etag: "e",
              metadata_json: "{}",
              updated_at: 0n,
              extra: "not exposed",
            },
          ],
        },
      ],
    );
    const outputType = service._fields.find(
      ([name]) => name === "read_node",
    )![1].retTypes;
    expect(IDL.decode(outputType, encoded)).toEqual([
      {
        Ok: [
          {
            path: "/Knowledge/a",
            content: "hi",
            etag: "e",
            metadata_json: "{}",
            updated_at: 0n,
          },
        ],
      },
    ]);
  });
  it("validates server limit configuration", () => {
    expect(parseLimits()).toEqual(DEFAULT_LIMITS);
    expect(parseLimits('{"questions":3}').questions).toBe(3);
    expect(() => parseLimits('{"questions":-1}')).toThrow();
    expect(() => parseLimits('{"unknown":1}')).toThrow();
    expect(isReadablePath("/Knowledge/a?b")).toBe(false);
  });
});
