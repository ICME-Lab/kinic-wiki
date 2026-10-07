import type { QuestionSubject } from "./contracts";
import type { DeepSeekTurn } from "./deepseek";
import type { KinicReader } from "./kinic";
import type { AskAiRoute } from "./routing";

// Deterministic targets need no model round trip to request the first reads.
// Focused search keeps the model's query rewriting and Jev ranking intact.
export async function seedTextContext(input: {
  route: AskAiRoute; subject: QuestionSubject; requestId: string;
  state: DeepSeekTurn; reader: KinicReader; checkActive: () => Promise<void>;
}): Promise<void> {
  const { route, subject, requestId, state, reader, checkActive } = input;
  if (route !== "database_overview" && (route !== "selected_node_summary" || subject.kind !== "node")) return;
  let paths: string[];
  if (route === "database_overview") {
    await checkActive();
    const id = `seed-inventory-${requestId}`;
    const output = await reader.execute("wiki_inventory", {});
    await checkActive();
    state.messages.push({ role: "assistant", content: null, tool_calls: [
      { id, type: "function", function: { name: "wiki_inventory", arguments: "{}" } },
    ] }, { role: "tool", tool_call_id: id, content: output });
    const inventory = JSON.parse(output) as { nodes: { path: string }[] };
    // Empty documents do not consume the four evidence slots. Try remaining
    // representatives within the existing tool-call budget.
    paths = inventory.nodes.slice(0, Math.max(0, reader.maxCalls - reader.state.calls)).map((node) => node.path);
  } else if (subject.kind === "node") {
    paths = [subject.path];
  } else return;
  for (let offset = 0; offset < paths.length; offset += 2) {
    if (route === "database_overview" && reader.state.readPaths.length >= 4) break;
    const args = paths.slice(offset, offset + 2).map((path) => ({ path, start: 0 }));
    await checkActive();
    const outputs = await reader.executeReadBatch(args, { skipEmpty: true });
    await checkActive();
    const calls = args.map((value, index) => ({
      id: `seed-read-${requestId}-${offset + index}`, type: "function" as const,
      function: { name: "wiki_read", arguments: JSON.stringify(value) },
    }));
    state.messages.push({ role: "assistant", content: null, tool_calls: calls });
    outputs.forEach((content, index) => state.messages.push({ role: "tool", tool_call_id: calls[index]!.id, content }));
  }
  state.messages.push({ role: "user", content: route === "database_overview"
    ? "Wiki inventory and representative reads are complete. Now answer the original question using this evidence. Return ONLY a nonempty JSON object with answer, citations [{id,quote}], insufficient, contradictions and unverified. Describe the observed scope and any inventory truncation; do not claim complete coverage. If no usable evidence was found, set insufficient to true. Do not request more tools."
    : "The selected document's first excerpt is ready. Answer the original question using this evidence, or read further excerpts if needed. Your final answer must be a nonempty JSON object with answer, citations [{id,quote}], insufficient, contradictions and unverified." });
}
