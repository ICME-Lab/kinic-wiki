import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildNode, DatabaseSummary, WikiNode } from "@/lib/types";
import { loadWikiDatabasePageData, wikiDatabaseHead, WikiDatabaseDocument } from "./page";

const api = vi.hoisted(() => ({ listDatabasesPublic: vi.fn(), readNode: vi.fn(), listChildren: vi.fn() }));
vi.mock("@/lib/public-seo-http", () => ({fetchPublicSeoPayload: async (canister: string, id: string, path: string) => {
  try {
    const database = (await api.listDatabasesPublic(canister)).find((entry: DatabaseSummary) => entry.databaseId === id);
    const node = await api.readNode(canister,id,path);
    const folder = !node || node.kind === "folder";
    const children = folder ? (await api.listChildren(canister,id,path)).filter((entry: ChildNode) => entry.name !== "index.md") : [];
    const render = folder ? await api.readNode(canister,id,`${path}/index.md`) : node;
    return {database,node:render,children:children.slice(0,100),childrenTruncated:children.length>100,hasContent:Boolean(database||render||children.length)};
  } catch { return null; }
}}));

const database: DatabaseSummary = {
  databaseId: "db_alpha", name: "Public database", role: "reader", status: "active",
  logicalSizeBytes: "0", cyclesBalance: "0", cyclesSuspendedAtMs: null, deletedAtMs: null,
  metadata: { name: "Public database", description: "Public description", tagsJson: "[]", llmSummary: null }
};
function node(content: string, path = "/Knowledge/note.md", kind: WikiNode["kind"] = "file"): WikiNode {
  return { path, content, kind, metadataJson: "{}", etag: "e", createdAt: "0", updatedAt: "0" };
}

beforeEach(() => {
  vi.stubEnv("VITE_KINIC_WIKI_CANISTER_ID", "t63gs-up777-77776-aaaba-cai");
  api.listDatabasesPublic.mockResolvedValue([database]);
  api.readNode.mockResolvedValue(node("# Note\nBody"));
  api.listChildren.mockResolvedValue([]);
});
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });

describe("public article SEO page", () => {
  it("reuses the summary for HTML and metadata, escapes markup, and omits full VFS data", async () => {
    api.readNode.mockResolvedValue(node("---\ntitle: Shared title\n---\n<img onerror='bad'> & \"quoted\" [Label](https://example.com)\n" + "body ".repeat(20_000) + "TAIL_SENTINEL"));
    const data = await loadWikiDatabasePageData("db_alpha", ["Knowledge", "note.md"]);
    const html = renderToStaticMarkup(<WikiDatabaseDocument data={data} />);
    const head = wikiDatabaseHead(data);
    expect(html).toContain("Shared title - Public database");
    expect(html).toContain("&amp;");
    expect(html).not.toContain("<img");
    expect(html).not.toContain('href="https://example.com"');
    expect(html).toContain("Label");
    expect(head.meta).toContainEqual({ title: data.summary.title });
    expect(head.meta).toContainEqual({ name: "description", content: data.summary.description });
    expect(head.links[0].href).toBe("/db/db_alpha/Knowledge/note.md");
    expect(JSON.stringify(data)).not.toContain("TAIL_SENTINEL");
    expect(JSON.stringify(data).length).toBeLessThan(10_000);
    expect(api.readNode).toHaveBeenCalledTimes(1);
    expect(api.listChildren).not.toHaveBeenCalled();
  });

  it("preserves folder order, excludes index.md, and caps serialized links at 100", async () => {
    api.readNode.mockImplementation(async (_canister: string, _database: string, path: string) => path.endsWith("index.md") ? node("# Folder body", path) : node("", path, "folder"));
    const children: ChildNode[] = Array.from({ length: 102 }, (_, i) => ({ path: `/Knowledge/${i}.md`, name: `${i}.md`, kind: "file", updatedAt: null, etag: null, sizeBytes: null, isVirtual: false, hasChildren: false, isPublished: false }));
    api.listChildren.mockResolvedValue([{ ...children[0], name: "index.md", path: "/Knowledge/index.md" }, ...children]);
    const data = await loadWikiDatabasePageData("db_alpha");
    expect(data.children).toHaveLength(100);
    expect(data.children.map((child) => child.name)).toEqual(children.slice(0, 100).map((child) => child.name));
    expect(data.childrenTruncated).toBe(true);
    const html = renderToStaticMarkup(<WikiDatabaseDocument data={data} />);
    expect(html).toContain('href="/db/db_alpha/Knowledge/99.md"');
    expect(html).not.toContain('href="/db/db_alpha/Knowledge/100.md"');
    expect(html).toContain("Open this folder in the Wiki browser");
    expect(data.summary.title).toBe("Folder body - Public database");
  });

  it("fetches again after public access is revoked; does not reuse the earlier body", async () => {
    expect((await loadWikiDatabasePageData("db_alpha")).summary.textExcerpt).toContain("Body");
    api.listDatabasesPublic.mockResolvedValue([]);
    api.readNode.mockRejectedValue(new Error("Forbidden"));
    api.listChildren.mockRejectedValue(new Error("Forbidden"));
    const data = await loadWikiDatabasePageData("db_alpha");
    expect(data.hasContent).toBe(false);
    expect(renderToStaticMarkup(<WikiDatabaseDocument data={data} />)).toBe("");
    expect(JSON.stringify(data)).not.toContain("Body");
    expect(api.listDatabasesPublic).toHaveBeenCalledTimes(2);
  });

  it("does not show a body for missing nodes or fetch browser-only routes", async () => {
    api.readNode.mockResolvedValue(null);
    const missing = await loadWikiDatabasePageData("db_alpha", ["missing.md"]);
    expect(missing.summary.textExcerpt).toBe("");
    vi.clearAllMocks();
    const browserOnly = await loadWikiDatabasePageData("db_alpha", ["search"]);
    expect(renderToStaticMarkup(<WikiDatabaseDocument data={browserOnly} />)).toBe("");
    expect(wikiDatabaseHead(browserOnly).meta).toContainEqual({ name: "robots", content: "noindex,follow" });
    expect(api.readNode).not.toHaveBeenCalled();
  });
});
