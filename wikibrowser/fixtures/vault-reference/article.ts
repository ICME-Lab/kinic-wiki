// Isolated Wiki persistence for the component fixture. The production editor
// calls its normal write adapter; only this Vite configuration replaces it.
import type { WikiNode, WriteNodeRequest } from "@/lib/types";

const key = "fixture-article";
export const original: WikiNode = {
  path: "/Knowledge/private-document.md", kind: "file", content: "Original draft.",
  createdAt: "0", updatedAt: "0", etag: "fixture", metadataJson: "{}"
};
export function readArticle(): WikiNode {
  const stored = sessionStorage.getItem(key);
  return stored ? JSON.parse(stored) : original;
}
export async function writeNodeAuthenticated(_canister: string, _identity: unknown, request: WriteNodeRequest) {
  const current = readArticle();
  if (request.path !== current.path || request.expectedEtag !== current.etag) throw Error("Fixture article changed");
  const node = { ...current, content: request.content, etag: crypto.randomUUID() };
  sessionStorage.setItem(key, JSON.stringify(node));
  return { created: false, node };
}
