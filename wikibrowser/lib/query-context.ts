import type { Identity } from "@icp-sdk/core/agent";
import type { NodeContext, WikiNode } from "@/lib/types";
import { queryAnswerSearchTerms } from "@/lib/query-actions";
import { queryContext, readNodeContext, searchNodes } from "@/lib/vfs-client";

export type QueryAnswerContext = {
  path: string;
  title: string;
  excerpt: string;
};

const MAX_CONTEXT_ITEMS = 6;
const MAX_CONTEXT_CHARS = 18_000;
const MAX_EXCERPT_CHARS = 4_000;
const CONTEXT_BUDGET_TOKENS = 4_500;

export async function collectQueryAnswerContext(input: {
  canisterId: string;
  databaseId: string;
  question: string;
  selectedPath: string;
  currentNode: WikiNode | null;
  readIdentity: Identity | null;
}): Promise<QueryAnswerContext[]> {
  const nodes = new Map<string, WikiNode>();
  if (input.currentNode && isAnswerContextNode(input.currentNode)) {
    nodes.set(input.currentNode.path, input.currentNode);
  }
  const context = await queryContext(input.canisterId, input.databaseId, input.question, CONTEXT_BUDGET_TOKENS, input.readIdentity ?? undefined);
  for (const nodeContext of context.nodes) {
    if (nodes.size >= MAX_CONTEXT_ITEMS) break;
    const node = nodeContext.node;
    if (isAnswerContextNode(node) && !nodes.has(node.path)) nodes.set(node.path, node);
  }
  for (const term of queryAnswerSearchTerms(input.question)) {
    if (nodes.size >= MAX_CONTEXT_ITEMS) break;
    const hits = await searchNodes(input.canisterId, input.databaseId, term, 4, "/Wiki", input.readIdentity ?? undefined);
    for (const hit of hits) {
      if (nodes.size >= MAX_CONTEXT_ITEMS) break;
      if (nodes.has(hit.path)) continue;
      const nodeContext = await readNodeContext(input.canisterId, input.databaseId, hit.path, 5, input.readIdentity ?? undefined);
      if (nodeContext && isAnswerContextNode(nodeContext.node)) nodes.set(nodeContext.node.path, nodeContext.node);
    }
  }
  return trimContext([...nodes.values()].map((node) => contextFromNode(node, context.nodes.find((item) => item.node.path === node.path) ?? null)));
}

function contextFromNode(node: WikiNode, context: NodeContext | null): QueryAnswerContext {
  return {
    path: node.path,
    title: titleForNode(node),
    excerpt: excerptForNode(node, context).slice(0, MAX_EXCERPT_CHARS)
  };
}

function trimContext(items: QueryAnswerContext[]): QueryAnswerContext[] {
  const trimmed: QueryAnswerContext[] = [];
  let total = 0;
  for (const item of items) {
    if (total >= MAX_CONTEXT_CHARS) break;
    const remaining = MAX_CONTEXT_CHARS - total;
    const excerpt = item.excerpt.slice(0, remaining);
    if (!excerpt.trim()) continue;
    total += excerpt.length;
    trimmed.push({ ...item, excerpt });
  }
  return trimmed;
}

function titleForNode(node: WikiNode): string {
  const heading = node.content.split("\n").find((line) => line.startsWith("# "));
  return heading ? heading.slice(2).trim() : node.path.split("/").at(-1) ?? node.path;
}

function excerptForNode(node: WikiNode, context: NodeContext | null): string {
  const links = context?.outgoingLinks.slice(0, 5).map((link) => `- ${link.targetPath}`).join("\n") ?? "";
  return links ? `${node.content}\n\nOutgoing links:\n${links}` : node.content;
}

function isContextPath(path: string): boolean {
  return path === "/Wiki" || path.startsWith("/Wiki/") || path === "/Sources" || path.startsWith("/Sources/");
}

function isAnswerContextNode(node: WikiNode): boolean {
  return (node.kind === "file" || node.kind === "source") && isContextPath(node.path) && node.content.trim().length > 0;
}
