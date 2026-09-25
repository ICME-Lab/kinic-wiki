import {
  readNodeRaw,
  type ReadActor,
  type WikiNodeEntry,
} from "@kinic/ii-server/read";
import { JevError, rerankWithJev } from "@kinic/jev-reranker";
export {
  createReadActor,
  type ReadActor,
  type WikiReadNode as Node,
} from "@kinic/ii-server/read";
import { z } from "zod";
import {
  AssistantError,
  isReadablePath,
  scopeSchema,
  type Citation,
  type Scope,
} from "./contracts";
import type { AskAiRoute } from "./routing";

type Result<T> = { Ok: T } | { Err: string };
type Manifest = {
  api_version: string;
  recommended_entrypoint: string;
  roots: { path: string; kind: string }[];
};
function unwrap<T>(result: Result<T>): T {
  // Never include canister errors (which may contain private paths) in public errors.
  if ("Err" in result) throw new AssistantError("wiki_read_denied", 403);
  return result.Ok;
}
export type ToolState = {
  calls: number;
  characters: number;
  evidence: Citation[];
  sources: string[];
  readPaths: string[];
  discoveredPaths: string[];
  jevDurationMs: number;
  jevRouteDurationMs: number;
  jevRerankDurationMs: number;
  inventoryObserved: number;
  inventoryTruncated: boolean;
};
export const emptyToolState = (): ToolState => ({
  calls: 0,
  characters: 0,
  evidence: [],
  sources: [],
  readPaths: [],
  discoveredPaths: [],
  jevDurationMs: 0,
  jevRouteDurationMs: 0,
  jevRerankDurationMs: 0,
  inventoryObserved: 0,
  inventoryTruncated: false,
});

export class KinicReader {
  constructor(
    readonly actor: ReadActor,
    readonly databaseId: string,
    readonly scope: Scope,
    readonly state: ToolState,
    readonly maxCharacters = 24000,
    readonly maxCalls = 12,
    readonly typesafeApiKey = "",
    readonly route?: AskAiRoute,
  ) {}
  async authorize(): Promise<void> {
    unwrap(
      await this.actor.read_node(
        this.databaseId,
        this.scope === "database" ? "/Knowledge" : this.scope,
      ),
    );
  }
  async manifest(): Promise<Manifest> {
    await this.authorize();
    const result = unwrap(
      await this.actor.memory_manifest({ database_id: this.databaseId }),
    );
    if (result.recommended_entrypoint !== "query_context")
      throw new AssistantError("unsupported_wiki_api", 503);
    return result;
  }
  private path(path: string): void {
    const databaseDocument =
      this.scope === "database" &&
      (path.startsWith("/Knowledge/") ||
        path.startsWith("/Memory/") ||
        this.state.discoveredPaths.includes(path));
    if (
      !isReadablePath(path) ||
      !(
        databaseDocument ||
        path === this.scope ||
        path.startsWith(this.scope + "/") ||
        this.state.sources.includes(path)
      )
    )
      throw new AssistantError("path_not_allowed", 403);
  }
  private bounded(value: unknown): string {
    const text = JSON.stringify(value);
    if (this.state.characters + text.length > this.maxCharacters)
      throw new AssistantError("context_limit");
    this.state.characters += text.length;
    return text;
  }
  private async sourceRefs(path: string) {
    const result = unwrap(
      await this.actor.source_evidence({
        database_id: this.databaseId,
        node_path: path,
      }),
    );
    return result.refs
      .filter(
        (ref) =>
          ref.source_path.startsWith("/Sources/") &&
          isReadablePath(ref.source_path),
      )
      .slice(0, 10)
      .map((ref) => ({
        path: ref.source_path,
        etag: ref.source_etag[0] ?? null,
        updatedAt: ref.source_updated_at[0]?.toString() ?? null,
      }));
  }
  async execute(name: string, args: unknown): Promise<string> {
    if (++this.state.calls > this.maxCalls)
      throw new AssistantError("tool_limit");
    await this.authorize();
    if (this.route === "conversation")
      throw new AssistantError("tool_not_allowed", 403);
    if (name === "wiki_query") {
      if (this.route && this.route !== "focused_search")
        throw new AssistantError("tool_not_allowed", 403);
      const input = z
        .object({ question: z.string().min(1).max(4000), scope: scopeSchema })
        .strict()
        .parse(args);
      if (input.scope !== this.scope)
        throw new AssistantError("scope_not_allowed", 403);
      const search = async (prefix: [] | [string], top_k: number) =>
        unwrap(await this.actor.search_nodes({
          database_id: this.databaseId,
          query_text: input.question,
          prefix,
          top_k,
          preview_mode: [{ Light: null }],
        }));
      // Search the two document trees independently. A database-wide top 20 can
      // otherwise be filled by /Sources or other folders before filtering.
      const groups = this.scope === "database"
        ? await Promise.all([
            search(["/Knowledge"], 20),
            search(["/Memory"], 20),
            search([], 100),
          ])
        : [await search([this.scope], 20)];
      const allowed = groups.map((result, index) => result.filter((hit) =>
        this.scope === "database"
          ? index === 0
            ? hit.path.startsWith("/Knowledge/")
            : index === 1
              ? hit.path.startsWith("/Memory/")
              : /^\/[^/]+$/u.test(hit.path)
          : hit.path.startsWith(this.scope + "/") || hit.path === this.scope,
      ));
      const seen = new Set<string>();
      const candidates = [];
      // Take one candidate from each tree per pass so a busy tree cannot use
      // the whole Jev candidate budget before another tree is considered.
      for (let rank = 0; candidates.length < 20 && allowed.some((group) => rank < group.length); rank++) {
        for (const group of allowed) {
          const hit = group[rank];
          if (hit && !seen.has(hit.path)) {
            seen.add(hit.path);
            candidates.push(hit);
          }
          if (candidates.length === 20) break;
        }
      }
      const previews = candidates
        .map((hit) => ({
          path: hit.path,
          preview: hit.preview[0]?.excerpt[0] ?? hit.snippet[0] ?? "",
        }));
      let selected;
      try {
        const reranked = await rerankWithJev({
          intent: input.question,
          candidates: previews,
          apiKey: this.typesafeApiKey,
          workflow: "ask_ai",
        });
        this.state.jevDurationMs += reranked.durationMs;
        this.state.jevRerankDurationMs += reranked.durationMs;
        selected = reranked.candidates;
      } catch (error) {
        if (error instanceof JevError) {
          this.state.jevDurationMs += error.durationMs;
          this.state.jevRerankDurationMs += error.durationMs;
          throw new AssistantError("jev_unavailable", 503);
        }
        throw error;
      }
      this.state.discoveredPaths.push(
        ...selected
          .map(({ path }) => path)
          .filter((path) => !this.state.discoveredPaths.includes(path)),
      );
      return this.bounded({
        nodes: selected,
      });
    }
    if (name === "wiki_inventory") {
      if (this.route && this.route !== "database_overview")
        throw new AssistantError("tool_not_allowed", 403);
      if (this.scope !== "database")
        throw new AssistantError("scope_not_allowed", 403);
      const limit = 100;
      const [root, knowledge, memory] = await Promise.all([
        this.actor.list_nodes({
          database_id: this.databaseId,
          prefix: "/",
          recursive: false,
          limit,
        }),
        this.actor.list_nodes({
          database_id: this.databaseId,
          prefix: "/Knowledge",
          recursive: true,
          limit,
        }),
        this.actor.list_nodes({
          database_id: this.databaseId,
          prefix: "/Memory",
          recursive: true,
          limit,
        }),
      ]).then((results) => results.map(unwrap));
      const rootDocuments = root.filter(
        (entry) =>
          isDocumentEntry(entry.kind) &&
          /^\/[^/]+$/u.test(entry.path) &&
          !["/Knowledge", "/Memory", "/Sources", "/Skills", "/Sessions"].includes(
            entry.path,
          ),
      );
      const knowledgeDocuments = knowledge.filter(
        (entry) =>
          isDocumentEntry(entry.kind) && entry.path.startsWith("/Knowledge/"),
      );
      const memoryDocuments = memory.filter(
        (entry) =>
          isDocumentEntry(entry.kind) && entry.path.startsWith("/Memory/"),
      );
      const documents = [
        ...rootDocuments,
        ...knowledgeDocuments,
        ...memoryDocuments,
      ];
      const representative = selectRepresentativeEntries(documents, 20);
      const nodes = await Promise.all(
        representative.map(async (entry) => {
          const node = unwrap(
            await readNodeRaw(this.actor, this.databaseId, entry.path),
          )[0];
          return {
            path: entry.path,
            updatedAt: entry.updated_at.toString(),
            preview: node?.content.slice(0, 160) ?? "",
          };
        }),
      );
      this.state.discoveredPaths.push(
        ...nodes
          .map(({ path }) => path)
          .filter((path) => !this.state.discoveredPaths.includes(path)),
      );
      this.state.inventoryObserved = documents.length;
      this.state.inventoryTruncated =
        root.length === limit ||
        knowledge.length === limit ||
        memory.length === limit;
      return this.bounded({
        observed: {
          root: rootDocuments.length,
          knowledge: knowledgeDocuments.length,
          memory: memoryDocuments.length,
        },
        truncated: this.state.inventoryTruncated,
        nodes,
      });
    }
    if (name === "wiki_read") {
      if (this.route === "database_overview" && this.state.readPaths.length >= 4)
        throw new AssistantError("overview_read_limit");
      const input = z
        .object({
          path: z.string(),
          start: z.number().int().nonnegative().max(10000000),
        })
        .strict()
        .parse(args);
      if (
        this.route &&
        !this.state.discoveredPaths.includes(input.path) &&
        !this.state.sources.includes(input.path)
      )
        throw new AssistantError("path_not_discovered", 403);
      this.path(input.path);
      const node = unwrap(
        await readNodeRaw(this.actor, this.databaseId, input.path),
      )[0];
      if (!node || node.path !== input.path)
        throw new AssistantError("node_not_found", 404);
      const remaining = Math.max(
        0,
        this.maxCharacters - this.state.characters - 1500,
      );
      const excerpt = node.content.slice(
        input.start,
        input.start + Math.min(4000, remaining),
      );
      if (!excerpt) throw new AssistantError("empty_excerpt_or_budget");
      const citation: Citation = {
        id: crypto.randomUUID(),
        databaseId: this.databaseId,
        path: node.path,
        excerpt,
        start: input.start,
        end: input.start + excerpt.length,
        etag: node.etag,
        retrievedAt: new Date().toISOString(),
      };
      const sourceRefs =
        this.route === "focused_search" && !node.path.startsWith("/Sources/")
          ? await this.sourceRefs(node.path)
          : [];
      const output = this.bounded({
        ...citation,
        totalCharacters: node.content.length,
        metadata: node.metadata_json.slice(0, 400),
        sourceRefs,
      });
      this.state.evidence.push(citation);
      this.state.readPaths.push(input.path);
      this.state.sources.push(
        ...sourceRefs
          .map((ref) => ref.path)
          .filter((path) => !this.state.sources.includes(path)),
      );
      return output;
    }
    if (name === "wiki_sources") {
      const input = z.object({ path: z.string() }).strict().parse(args);
      this.path(input.path);
      if (!this.state.readPaths.includes(input.path))
        throw new AssistantError("read_node_first");
      const refs = await this.sourceRefs(input.path);
      const output = this.bounded({ refs });
      this.state.sources.push(...refs.map((ref) => ref.path));
      return output;
    }
    throw new AssistantError("unknown_tool", 403);
  }
}

function isDocumentEntry(kind: WikiNodeEntry["kind"]): boolean {
  return "File" in kind || "Source" in kind;
}

function representativeGroup(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length === 1) return "/";
  if (parts.length === 2) return `/${parts[0]}`;
  return `/${parts[0]}/${parts[1]}`;
}

function representativePriority(path: string): number {
  const name = path.split("/").at(-1) ?? "";
  return /^(?:readme|index|overview|概要)(?:\.|$)/iu.test(name) ? 0 : 1;
}

export function selectRepresentativeEntries(
  entries: WikiNodeEntry[],
  limit: number,
): WikiNodeEntry[] {
  const groups = new Map<string, WikiNodeEntry[]>();
  for (const entry of entries) {
    const group = representativeGroup(entry.path);
    groups.set(group, [...(groups.get(group) ?? []), entry]);
  }
  const queues = [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, values]) =>
      values.sort(
        (left, right) =>
          representativePriority(left.path) -
            representativePriority(right.path) ||
          Number(right.updated_at - left.updated_at) ||
          left.path.localeCompare(right.path),
      ),
    );
  const selected: WikiNodeEntry[] = [];
  while (selected.length < limit && queues.some((queue) => queue.length)) {
    for (const queue of queues) {
      const entry = queue.shift();
      if (entry) selected.push(entry);
      if (selected.length === limit) break;
    }
  }
  return selected;
}
