import type { ChatMessage } from "./deepseek";
import type { KinicReader } from "./kinic";

// Only the first model-directed search is eligible. Later searches and chunk
// reads stay model-directed, preserving budgets for follow-up evidence.
export function prefetchSearchReads(messages: ChatMessage[], reader: KinicReader): { path: string; start: number }[] {
  if (messages.some(message => message.role === "assistant" &&
    message.tool_calls?.some(call => call.id.startsWith("prefetch-read-")))) return [];
  const searches = messages.flatMap(message => message.role === "assistant"
    ? (message.tool_calls ?? []).filter(call => call.function.name === "wiki_query") : []);
  if (!searches.length) return [];
  const last = [...messages].reverse().find(message => message.role === "assistant");
  if (last?.role !== "assistant" || !searches.every(search => last.tool_calls?.some(call => call.id === search.id))) return [];
  const ranked = searches.map(search => {
    const output = messages.find(message => message.role === "tool" && message.tool_call_id === search.id);
    if (output?.role !== "tool") return [];
    const value: unknown = JSON.parse(output.content);
    if (!value || typeof value !== "object" || !("nodes" in value) || !Array.isArray(value.nodes)) return [];
    return value.nodes.flatMap((node: unknown) => node && typeof node === "object" &&
      "path" in node && typeof node.path === "string" ? [node.path] : []);
  });
  // Reserve ample space for subsequent chunks; each committed excerpt can use
  // 4000 characters plus metadata/source references within the shared budget.
  const count = Math.min(2, reader.maxCalls - reader.state.calls,
    Math.floor((reader.maxCharacters - reader.state.characters - 6000) / 5500));
  // Multiple queries in the first batch each contribute their strongest hit.
  const paths: string[] = [];
  for (let index = 0; index < Math.max(0, ...ranked.map(paths => paths.length)); index++)
    for (const pathsForQuery of ranked) if (pathsForQuery[index]) paths.push(pathsForQuery[index]!);
  return [...new Set(paths)].filter(path => reader.state.discoveredPaths.includes(path) &&
    !reader.state.readPaths.includes(path)).slice(0, Math.max(0, count)).map(path => ({ path, start: 0 }));
}
