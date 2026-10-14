import { JevError, rerankWithJev } from "@kinic/jev-reranker";
import { createRetrievalSearcher, type RuntimeEnv, type SearchHit, type RetrievalSearchHit } from "./vfs.js";

type Candidate = { path: string; preview: string; hit: SearchHit };
const STOP = new Set("a an the how what when why which is are was were be been to of on in for by with and or do does can could use using get set from as this that tell explain please".split(" "));

export function retrievalTerms(query: string): string[] {
  return [...new Set((query.slice(0, 512).match(/[a-zA-Z_$][a-zA-Z0-9_.$-]*(?:\(\))?/g) ?? [])
    .map(t => t.toLowerCase().replace(/\(\)$/, ""))
    .filter(t => t.length > 1 && !STOP.has(t)))].slice(0, 16);
}

export function auxiliaryQueries(query: string, candidates: Array<{ path: string; preview: string }>): string[] {
  const terms = retrievalTerms(query);
  if (!terms.length) return [];
  const records = candidates.map(c => (c.path + " " + c.preview).toLowerCase());
  const scored = terms.map((t, i) => ({ t, i, n: records.filter(s => s.includes(t)).length }));
  const useful = scored.filter(x => x.n / Math.max(1, records.length) < .85 || x.t.includes("."));
  const focus = [...(useful.length ? useful : scored.map(x => ({ ...x, n: 1 })))].sort((a, b) => a.n - b.n || a.i - b.i)
    .slice(0, 3).sort((a, b) => a.i - b.i).map(x => x.t).join(" ");
  const rare = [...scored].sort((a, b) => a.n - b.n || b.t.length - a.t.length || a.i - b.i)[0].t;
  return [...new Set([focus, rare])].filter(q => q && q !== query.toLowerCase().trim());
}

export function selectRetrievalCandidates(intent: string, lists: Candidate[][]): Candidate[] {
  const unique = new Map<string, Candidate & { rrf: number }>();
  for (const list of lists.slice(0, 3)) for (const [i, candidate] of list.slice(0, 20).entries()) {
    const prior = unique.get(candidate.path);
    if (prior) prior.rrf += 1 / (60 + i);
    else unique.set(candidate.path, { ...candidate, rrf: 1 / (60 + i) });
  }
  const candidates = [...unique.values()].sort((a, b) => b.rrf - a.rrf).slice(0, 60);
  const terms = retrievalTerms(intent), n = Math.max(1, candidates.length);
  const fields = candidates.map(c => ({
    title: c.path.split("/").at(-1)!.replace(/--[a-f0-9]{8,}/g, "").toLowerCase(),
    preview: c.preview.toLowerCase()
  }));
  const idf = new Map(terms.map(t => [t, 1 + Math.log(1 + n / (1 + fields.filter(f => (f.title + " " + f.preview).includes(t)).length))]));
  return candidates.map((c, i) => ({ c, i, score: terms.reduce((score, t) => score + idf.get(t)! *
    ((fields[i].title.includes(t) ? 2 : 0) + (fields[i].preview.includes(t) ? 1 : 0)), 0) }))
    .sort((a, b) => b.score - a.score || a.i - b.i).slice(0, 20).map(v => v.c);
}

export async function retrievalSearch(
  env: RuntimeEnv, databaseId: string, intent: string, prefix: string, limit: number,
  order: (hits: SearchHit[]) => SearchHit[]
): Promise<SearchHit[]> {
  const started = Date.now();
  let queryCount = 1, auxiliaryFailures = 0, candidateCount = 0;
  let fallback: string | null = null;
  try {
    const search = await createRetrievalSearcher(env);
    const ordered = (items: RetrievalSearchHit[]): RetrievalSearchHit[] => {
      const map = new Map(items.map(item => [item.hit.path, item]));
      return order(items.map(item => item.hit)).map(hit => map.get(hit.path)!);
    };
    const initial = ordered(await search(databaseId, intent, intent, prefix));
    const queries = auxiliaryQueries(intent, initial.map(({ hit }) => ({
      path: hit.path, preview: hit.preview?.excerpt ?? hit.snippet ?? ""
    })));
    queryCount += queries.length;
    const extras = await Promise.all(queries.map(async query => {
      try { return ordered(await search(databaseId, query, intent, prefix)); }
      catch { auxiliaryFailures++; return []; }
    }));
    const candidates = selectRetrievalCandidates(intent, [initial, ...extras].map(list => list.map(item => ({
      path: item.hit.path, preview: item.rerankExcerpt, hit: item.hit
    }))));
    candidateCount = candidates.length;
    if (new TextEncoder().encode(JSON.stringify(candidates.map(({ path, preview }) => ({ path, preview })))).byteLength > 32_000) {
      fallback = "candidate_size";
      return candidates.slice(0, limit).map(c => c.hit);
    }
    try {
      const ranked = await rerankWithJev({
        intent, candidates, apiKey: env.TYPESAFE_API_KEY!, workflow: "mcp_search", selectionCount: limit,
        rerankEvenIfWithinLimit: true, timeoutMs: 1000, maxRequestBytes: 65_536, maxResponseBytes: 65_536
      });
      return ranked.candidates.map(c => c.hit);
    } catch (error) {
      fallback = error instanceof JevError ? error.code : "jev_unavailable";
      return candidates.slice(0, limit).map(c => c.hit);
    }
  } catch (error) {
    fallback = "retrieval_error";
    throw error;
  } finally {
    console.log(JSON.stringify({ event: "mcp_search_retrieval", queryCount, auxiliaryFailures,
      candidateCount, durationMs: Date.now() - started, fallback }));
  }
}
