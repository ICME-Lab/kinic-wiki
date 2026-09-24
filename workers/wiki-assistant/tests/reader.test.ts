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
  validateAnswer,
} from "../src/contracts";

function entry(
  path: string,
  updated_at: bigint,
  kind: "File" | "Source" | "Folder" | "Directory" = "File",
) {
  return {
    path,
    updated_at,
    etag: "v1",
    has_children: kind === "Folder" || kind === "Directory",
    kind: { [kind]: null } as
      | { File: null }
      | { Source: null }
      | { Folder: null }
      | { Directory: null },
  };
}

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
    search_nodes: vi.fn(async () => ({
      Ok: [
        {
          path: "/Knowledge/decision.md",
          snippet: ["本番の色は青"] as [string],
          preview: [{ excerpt: ["レビュー済み: 本番の色は青。"] as [string] }] as [{ excerpt: [string] }],
        },
      ],
    })),
    list_nodes: vi.fn(async () => ({ Ok: [] })),
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
  it("builds a bounded database inventory and excludes internal roots", async () => {
    const actor = fixtureActor();
    const inventoryNodes = new Map([
      ["/root.md", "root summary"],
      ["/Knowledge/overview.md", "knowledge overview"],
      ["/Memory/day.md", "memory entry"],
      ["/Sources/raw.md", "must not leak"],
    ]);
    actor.list_nodes = vi.fn(async ({ prefix }) => ({
      Ok:
        prefix === "/"
          ? [entry("/root.md", 1n), entry("/Sources", 2n, "Folder")]
          : prefix === "/Knowledge"
            ? [entry("/Knowledge/overview.md", 4n)]
            : [entry("/Memory/day.md", 3n)],
    }));
    actor.read_node = vi.fn(async (_db, path) => ({
      Ok: inventoryNodes.has(path)
        ? ([
            {
              path,
              content: inventoryNodes.get(path)!,
              etag: "v1",
              metadata_json: "{}",
              updated_at: 1n,
            },
          ] as [Node])
        : path === "/Knowledge"
          ? ([
              {
                path,
                content: "",
                etag: "root",
                metadata_json: "{}",
                updated_at: 1n,
              },
            ] as [Node])
          : ([] as []),
    }));
    const state = emptyToolState();
    const result = JSON.parse(
      await new KinicReader(
        actor,
        "db-a",
        "database",
        state,
        24000,
        12,
        "key",
        "database_overview",
      ).execute("wiki_inventory", {}),
    );
    expect(result.nodes.map((node: { path: string }) => node.path)).toEqual([
      "/root.md",
      "/Knowledge/overview.md",
      "/Memory/day.md",
    ]);
    expect(JSON.stringify(result)).not.toContain("/Sources/raw.md");
    expect(state.inventoryObserved).toBe(3);
    expect(state.discoveredPaths).toContain("/root.md");
  });

  it("limits overview reads to four exact nodes", async () => {
    const actor = fixtureActor();
    const state = emptyToolState();
    state.discoveredPaths.push("/root.md");
    actor.read_node = vi.fn(async (_db, path) => ({
      Ok: [
        {
          path,
          content: "overview evidence",
          etag: "v1",
          metadata_json: "{}",
          updated_at: 1n,
        },
      ] as [Node],
    }));
    const reader = new KinicReader(
      actor,
      "db-a",
      "database",
      state,
      24000,
      12,
      "key",
      "database_overview",
    );
    for (let index = 0; index < 4; index++)
      await reader.execute("wiki_read", { path: "/root.md", start: 0 });
    await expect(
      reader.execute("wiki_read", { path: "/root.md", start: 0 }),
    ).rejects.toThrow("overview_read_limit");
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
  it("does not leak cross-root search results", async () => {
    const actor = fixtureActor();
    actor.search_nodes = vi.fn(async () => ({
      Ok: [
        {
          path: "/Skills/evil.md",
          snippet: ["secret"] as [string],
          preview: [{ excerpt: ["secret"] as [string] }] as [{ excerpt: [string] }],
        },
      ],
    }));
    const result = await new KinicReader(
      actor,
      "db-a",
      "/Knowledge",
      emptyToolState(),
    ).execute("wiki_query", { question: "x", scope: "/Knowledge" });
    expect(result).not.toContain("secret");
    expect(JSON.parse(result).nodes).toEqual([]);
  });
  it("keeps Knowledge results when excluded paths fill the database search", async () => {
    const actor = fixtureActor();
    actor.search_nodes = vi.fn(async (request) => ({
      Ok: request.prefix[0] === "/Knowledge"
        ? [{ path: "/Knowledge/decision.md", snippet: ["answer"] as [string], preview: [] as [] }]
        : request.prefix[0] === "/Memory"
          ? []
          : Array.from({ length: 100 }, (_, index) => ({
              path: `/Sources/source-${index}.md`,
              snippet: ["source"] as [string],
              preview: [] as [],
            })),
    }));
    const output = JSON.parse(await new KinicReader(
      actor,
      "db-a",
      "database",
      emptyToolState(),
    ).execute("wiki_query", { question: "decision", scope: "database" })) as {
      nodes: { path: string }[];
    };
    expect(output.nodes.map(({ path }) => path)).toEqual(["/Knowledge/decision.md"]);
    expect(actor.search_nodes).toHaveBeenCalledWith(expect.objectContaining({
      prefix: ["/Knowledge"],
    }));
  });
  it("returns Jev-selected paths and previews in semantic order", async () => {
    const actor = fixtureActor();
    actor.search_nodes = vi.fn(async () => ({
      Ok: Array.from({ length: 6 }, (_, index) => ({
        path: `/Knowledge/${index}.md`,
        snippet: [`snippet-${index}`] as [string],
        preview: [] as [],
      })),
    }));
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      model: "jev-latest",
      answers: Object.fromEntries(
        [0.1, 0.9, 0.8, 0.7, 0.6, 0.5].map((noul, index) => [
          `candidate_${index}`,
          { type: "noul", noul },
        ]),
      ),
      usage: { input_tokens: 10, output_tokens: 6 },
    })));
    try {
      const state = emptyToolState();
      const output = JSON.parse(await new KinicReader(
        actor,
        "db-a",
        "/Knowledge",
        state,
        24000,
        12,
        "typesafe-key",
      ).execute("wiki_query", { question: "色は？", scope: "/Knowledge" })) as {
        nodes: { path: string; preview: string }[];
      };
      expect(output.nodes.map(({ path }) => path)).toEqual([
        "/Knowledge/1.md",
        "/Knowledge/2.md",
        "/Knowledge/3.md",
        "/Knowledge/4.md",
        "/Knowledge/5.md",
      ]);
      expect(output.nodes[0]?.preview).toBe("snippet-1");
      expect(state.jevDurationMs).toBeGreaterThanOrEqual(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("returns jev_unavailable without exposing FTS candidates", async () => {
    const actor = fixtureActor();
    actor.search_nodes = vi.fn(async () => ({
      Ok: Array.from({ length: 6 }, (_, index) => ({
        path: `/Knowledge/private-${index}.md`,
        snippet: [`private-${index}`] as [string],
        preview: [] as [],
      })),
    }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 529 })));
    try {
      await expect(new KinicReader(
        actor,
        "db-a",
        "/Knowledge",
        emptyToolState(),
        24000,
        12,
        "typesafe-key",
      ).execute("wiki_query", { question: "x", scope: "/Knowledge" })).rejects.toThrow("jev_unavailable");
    } finally {
      vi.unstubAllGlobals();
    }
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
    expect(
      validateAnswer({ ...answer, citations: [] }, [], false).citations,
    ).toEqual([]);
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
  it("uses only six canister query methods and decodes width-subtyped node records", () => {
    const service = readIdlFactory({ IDL });
    expect(service._fields.map(([name]) => name).sort()).toEqual([
      "list_nodes",
      "memory_manifest",
      "query_context",
      "read_node",
      "search_nodes",
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
  it("uses fixed server limits and rejects unsafe paths", () => {
    expect(DEFAULT_LIMITS.questions).toBe(50);
    expect(isReadablePath("/Knowledge/a?b")).toBe(false);
  });
});
