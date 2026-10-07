import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { answerSchema, validateAnswer } from "../src/contracts";
import { emptyToolState, KinicReader, type ReadActor } from "../src/kinic";
import { newDeepSeekTurn, runDeepSeekTurn } from "../src/deepseek";
import { inputText } from "../src/turn-input";
import { runTextTurn } from "../src/text-turn";
import type { TurnContext } from "../src/turn-context";
import type { Conversation, Pending } from "../src/state";
import { routeAskAiIntent } from "../src/routing";
afterEach(() => vi.unstubAllGlobals());

// Explicit opt-in: real Wiki excerpts go to the configured DeepSeek provider.
// No writes to the Wiki, no production deployment, and no keys in reports.
it("compares sequential and seeded retrieval with real Wiki and DeepSeek", async () => {
  const captureOnly = process.env.ASKAI_CAPTURE_ONLY === "1";
  if (!captureOnly && (process.env.KINIC_LIVE_PRIVATE_EGRESS !== "1" || !process.env.DEEPSEEK_API_KEY || !process.env.TYPESAFE_API_KEY))
    throw new Error("Explicit egress opt-in and DEEPSEEK_API_KEY are required");
  const databaseId = process.env.KINIC_LIVE_DATABASE_ID;
  const canisterId = process.env.KINIC_LIVE_CANISTER_ID;
  if (!databaseId || !canisterId || !process.env.ASKAI_ACCURACY_OUTPUT)
    throw new Error("Database, canister and local report path are required");
  const exec = promisify(execFile);
  const cli = resolve(import.meta.dirname, "../../../target/debug/kinic-vfs-cli");
  const call = async (args: string[]) => {
    try {
      const { stdout } = await exec(cli, ["--canister-id", canisterId, "--database-id", databaseId,
        "--identity-mode", "anonymous", ...args, "--json"], { timeout: 20000, maxBuffer: 2000000 });
      return JSON.parse(stdout);
    } catch { throw new Error("live_wiki_read_failed"); }
  };
  const actor = {
    read_node: async (_db: string, path: string) => {
      const node = await call(["read-node", "--path", path]);
      return { Ok: [{ ...node, updated_at: BigInt(node.updated_at) }] };
    },
    list_nodes: async (request: { prefix: string; recursive: boolean; limit: number }) => ({ Ok:
      (await call(["list-nodes", "--prefix", request.prefix, "--limit", String(request.limit),
        ...(request.recursive ? ["--recursive"] : [])])).map((node: { kind: string; updated_at: number }) => ({
          ...node, kind: { [node.kind === "file" ? "File" : node.kind === "source" ? "Source" : "Folder"]: null },
          updated_at: BigInt(node.updated_at),
        })) }),
    source_evidence: async (request: { node_path: string }) => {
      const result = await call(["source-evidence", "--node-path", request.node_path]);
      return { Ok: { ...result, refs: result.refs.map((ref: { source_etag: string | null; source_updated_at: string | number | null }) => ({
        ...ref, source_etag: ref.source_etag === null ? [] : [ref.source_etag],
        source_updated_at: ref.source_updated_at === null ? [] : [BigInt(ref.source_updated_at)],
      })) } };
    },
    search_nodes: async (request: { query_text: string; prefix: [] | [string]; top_k: number }) => ({ Ok:
      (await call(["search-remote", request.query_text, "--prefix", request.prefix[0] ?? "/", "--top-k", String(request.top_k),
        "--preview-mode", "light"])).map((hit: { snippet: string | null; preview: { excerpt: string } | null }) => ({
          ...hit, snippet: hit.snippet === null ? [] : [hit.snippet],
          preview: hit.preview === null ? [] : [{ ...hit.preview, excerpt: [hit.preview.excerpt] }],
        })) }),
    query_context: async () => { throw new Error("unexpected_query_context"); },
    memory_manifest: async () => { throw new Error("unexpected_manifest"); },
  } as ReadActor;
  await call(["status"]);
  const discovery = new KinicReader(actor, databaseId, "database", emptyToolState(), 24000, 12, "", "database_overview");
  const inventory = JSON.parse(await discovery.execute("wiki_inventory", {}));
  expect(inventory.nodes.length).toBeGreaterThan(0);
  const selectedPath: string = inventory.nodes.find((entry: { path: string }) => entry.path.endsWith("/honojs__hono/index.md"))?.path
    ?? inventory.nodes[0].path;
  const reference = await call(["read-node", "--path", selectedPath]);
  const cases = [
    { id: "overview-exact", route: "database_overview" as const, question: "このdbについて教えて" },
    { id: "overview-short", route: "database_overview" as const, question: "何が入ってるDB？" },
    { id: "overview-english", route: "database_overview" as const, question: "What is this database about? Summarize its contents with sources." },
    { id: "overview-1", route: "database_overview" as const, question: "このDBの内容を教えて。主な資料の分野と用途を根拠付きで説明して。" },
    { id: "overview-2", route: "database_overview" as const, question: "このDBの内容を教えて。主な資料の分野と用途を根拠付きで説明して。" },
    { id: "selected", route: "selected_node_summary" as const, question: "選択した文書の重要なポイントを、具体例を含めて要約して。" },
    { id: "code-source", route: "selected_node_summary" as const,
      path: "/Knowledge/sources/honojs__hono/llms-full/app-hono-request--5b485d82511c.md",
      question: "選択した文書を要約して。Requestを使うコード例の注意点も説明して。" },
    { id: "focused", route: "focused_search" as const, question: "このDB内のHonoドキュメントを検索して、app.requestによるHTTPハンドラーのテスト方法を教えて。引用元も示して。" },
    { id: "unknown", route: "focused_search" as const, question: "このDB内の資料を検索して、Honoプロジェクトの2027年度売上高を金額と通貨付きで教えて。資料にない場合は明示して。" },
    { id: "focused-cors", route: "focused_search" as const, question: "このDBのHono資料を検索して、CORSミドルウェアで許可するoriginとHTTPメソッドを指定する方法を、コード例と引用付きで教えて。" },
    { id: "focused-runtime", route: "focused_search" as const, question: "このDBの資料に基づいて、HonoをCloudflare WorkersとNode.jsで動かすときの違いを比較して。資料で確認できない点は明示して。" },
    { id: "greeting", route: "conversation" as const, question: "こんにちは！" },
    { id: "translation", route: "conversation" as const, question: "次の文章を英訳して：明日、会議の資料を送ります。" },
    { id: "ambiguous", route: null, question: "これどう？" },
  ].filter(item => !process.env.ASKAI_ACCURACY_CASES || process.env.ASKAI_ACCURACY_CASES.split(",").includes(item.id));
  const optimizedOnly = process.env.ASKAI_ACCURACY_MODE === "optimized";
  const mainBaseline = process.env.ASKAI_ACCURACY_BASELINE === "main";
  if (mainBaseline && cases.some(item => item.route !== "focused_search"))
    throw new Error("The main baseline comparison currently supports focused-search cases only");
  if (captureOnly) {
    const candidates = [];
    for (const entry of inventory.nodes) {
      const node = await call(["read-node", "--path", entry.path]);
      candidates.push({ path: node.path, etag: node.etag, excerpt: node.content.slice(0, 4000),
        content: node.content, metadata: node.metadata_json.slice(0, 400) });
    }
    await writeFile(process.env.ASKAI_ACCURACY_OUTPUT, JSON.stringify({ destination: "https://api.deepseek.com/chat/completions",
      model: "deepseek-flash", databaseId, canisterId, selectedPath, inventory, cases, candidates,
      note: "Reviewable candidate excerpts. Each overview answer reads at most four documents; selected summaries can request later chunks of the selected document." }, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ status: "captured_without_model_egress", candidates: candidates.length,
      characters: candidates.reduce((sum, node) => sum + node.excerpt.length, 0) }));
    return;
  }
  const rows: unknown[] = [];
  let providerResponses: unknown[] = [];
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
    const response = await realFetch(...args);
    if (String(args[0]) === "https://api.deepseek.com/chat/completions") {
      const text = await response.clone().text();
      providerResponses.push({ status: response.status, body: text });
    }
    return response;
  });
  try {
    for (const [index, item] of cases.entries()) for (const mode of optimizedOnly ? ["optimized"] : index % 2 ? ["optimized", "legacy"] : ["legacy", "optimized"]) {
      providerResponses = [];
      const requestId = crypto.randomUUID(), now = Date.now();
      const subject = item.route === "selected_node_summary" ? { kind: "node" as const, path: item.path ?? selectedPath }
        : { kind: "database" as const };
      const routed = await routeAskAiIntent({ question: item.question, subject, apiKey: process.env.TYPESAFE_API_KEY! });
      if (!routed.route) {
        rows.push({ caseId: item.id, mode, elapsedMs: Date.now() - now,
          ...(item.route === null ? { status: "clarification_required" } : { error: "jev_clarification_required" }) });
        console.log(JSON.stringify({ caseId: item.id, mode, status: "clarification_required" }));
        continue;
      }
      const route = routed.route;
      const pending: Pending = { input: { requestId, question: item.question, scope: "database", subject },
        generation: 1, started: now, stage: "new", turnId: null, tools: emptyToolState(), results: {}, delegationId: null, route };
      pending.tools.jevRouteDurationMs = routed.durationMs;
      if (subject.kind === "node") pending.tools.discoveredPaths.push(subject.path);
      const conversation = { format: 3, native: true, nativeTextProvider: "deepseek", id: "local-live", authId: "local",
        principal: "anonymous", databaseId, scope: "database", sessionId: null, generation: 1, pending, activity: now, seen: now,
        status: "working", error: null, messages: [], history: [], utterances: [], transcripts: [], delegations: [], deferred: null } as Conversation;
      const reader = new KinicReader(actor, databaseId, "database", pending.tools, 24000, 12, process.env.TYPESAFE_API_KEY!, route, mode === "legacy" && !mainBaseline);
      const context: TurnContext = { conversation, pending, route, subject, valid: async () => true,
        reader: async () => reader, checkpoint: async () => {} };
      const options = { apiKey: process.env.DEEPSEEK_API_KEY, deadline: now + 90000, signal: AbortSignal.timeout(90000) };
      let generatedAnswer: unknown;
      try {
        let answer, rounds, inputTokens, outputTokens, providerDurationMs, retrievalDurationMs;
        if (mode === "optimized") {
          const result = await runTextTurn(context, options);
          answer = result.answer; rounds = pending.deepseek!.rounds;
          inputTokens = result.inputTokens; outputTokens = result.outputTokens;
          providerDurationMs = result.providerDurationMs; retrievalDurationMs = result.retrievalDurationMs;
        } else {
          const state = newDeepSeekTurn(inputText(requestId, item.question, "database", undefined, [], route, subject));
          const raw = await runDeepSeekTurn({ ...options, state, scope: "database", route,
            authorize: () => reader.authorize(), checkpoint: async () => {}, execute: (name, args) => reader.execute(name, args),
            executeReadBatch: mainBaseline ? args => reader.executeReadBatch(args) : undefined });
          answer = validateAnswer(answerSchema.strip().parse(raw), pending.tools.evidence, route !== "conversation");
          rounds = state.rounds; inputTokens = state.inputTokens; outputTokens = state.outputTokens;
          providerDurationMs = state.providerDurationMs; retrievalDurationMs = state.retrievalDurationMs;
        }
        const row = { caseId: item.id, mode, route, expectedRoute: item.route, elapsedMs: Date.now() - now, rounds, inputTokens, outputTokens,
          baseline: mainBaseline ? "main-a965fcff-focused-runner-with-shared-reader" : "legacy", providerDurationMs, retrievalDurationMs,
          jevRouteDurationMs: routed.durationMs, jevRerankDurationMs: pending.tools.jevRerankDurationMs,
          reads: pending.tools.readPaths, evidence: pending.tools.evidence, answer, providerResponses };
        generatedAnswer = answer;
        if (mode === "optimized" && item.id === "unknown") expect(answer.insufficient).toBe(true);
        if (mode === "optimized" && item.id === "focused") {
          expect(answer.insufficient).toBe(false);
          expect(answer.answer).toContain("app.request");
          expect(answer.citations.some(citation => citation.path.includes("testing-request-and-response"))).toBe(true);
        }
        if (mode === "optimized" && item.route !== null) expect(route).toBe(item.route);
        if (mode === "optimized" && item.route === "database_overview") {
          expect(answer.insufficient).toBe(false);
          expect(answer.answer).toMatch(/Hono/i);
          expect(answer.citations.length).toBeGreaterThan(0);
          expect(pending.tools.readPaths.length).toBeLessThanOrEqual(4);
        }
        if (mode === "optimized" && item.route === "conversation") {
          expect(pending.tools.calls).toBe(0);
          expect(answer.citations).toHaveLength(0);
        }
        if (mode === "optimized" && item.id === "translation") {
          expect(answer.insufficient).toBe(false);
          expect(answer.answer).toMatch(/\btomorrow\b/i);
          expect(answer.answer).toMatch(/\bmeeting\b/i);
        }
        if (mode === "optimized" && item.id === "overview-english") {
          // Coarse language guard; manual review still checks meaning and facts.
          const opening = answer.answer.trim().split("\n")[0]!;
          const latin = opening.match(/\p{Script=Latin}/gu)?.length ?? 0;
          const han = opening.match(/\p{Script=Han}/gu)?.length ?? 0;
          expect(latin).toBeGreaterThan(han);
        }
        rows.push(row);
        console.log(JSON.stringify({ caseId: item.id, mode, route, elapsedMs: row.elapsedMs, rounds,
          citations: answer.citations.length, insufficient: answer.insufficient, status: "completed" }));
      } catch (error) {
        rows.push({ caseId: item.id, mode, route, expectedRoute: item.route, elapsedMs: Date.now() - now, error: error instanceof Error ? error.message : "failed",
          answer: generatedAnswer, reads: pending.tools.readPaths, characters: pending.tools.characters,
          calls: pending.tools.calls, providerResponses, state: pending.deepseek });
        console.log(JSON.stringify({ caseId: item.id, mode, status: "failed" }));
      }
    }
  } finally {
    await writeFile(process.env.ASKAI_ACCURACY_OUTPUT, JSON.stringify({ databaseId, canisterId, inventory,
      selectedReference: { path: selectedPath, etag: reference.etag, content: reference.content }, cases, rows }, null, 2), { mode: 0o600 });
  }
  expect(rows).toHaveLength(cases.length * (optimizedOnly ? 1 : 2));
  expect(rows.every(row => !(row as { error?: string }).error)).toBe(true);
}, 800000);
