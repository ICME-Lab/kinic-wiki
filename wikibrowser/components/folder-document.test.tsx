// @vitest-environment jsdom
import type { AnchorHTMLAttributes } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Identity } from "@icp-sdk/core/agent";
import { DocumentPane } from "./document-pane";
import type { ChildNode, WikiNode } from "@/lib/types";
import type { PathLoadState } from "@/lib/wiki-helpers";

const api = vi.hoisted(() => ({ write: vi.fn() }));
vi.mock("@/lib/vfs-client", () => ({ writeNodeAuthenticated: api.write }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => <a href={to} {...props}>{children}</a>
}));
vi.mock("@/components/markdown-editor", () => ({
  MarkdownEditor: ({ content, onChange, onSave }: { content: string; onChange: (text: string) => void; onSave: () => void }) => <div><textarea aria-label="Description" value={content} onChange={(event) => onChange(event.target.value)} /><button onClick={onSave}>Save</button></div>
}));
function node(path: string, content = "", kind: WikiNode["kind"] = "file"): WikiNode {
  return { path, kind, content, etag: "etag-existing", createdAt: "0", updatedAt: "0", metadataJson: "{}" };
}
function state<T>(data: T | null, error: string | null = null): PathLoadState<T> {
  return { path: "/Knowledge/demo", data, loading: false, error };
}
const child = (name: string): ChildNode => ({ name, path: `/Knowledge/demo/${name}`, kind: "file", etag: null, updatedAt: null, sizeBytes: null, isVirtual: false, hasChildren: false, isPublished: false });
const defaults = {
  canisterId: "test", databaseId: "fixture", view: "preview" as const,
  node: state(node("/Knowledge/demo", "", "folder")),
  childrenState: state([child("index.md"), child("article.md")]),
  folderOverviewNode: state<WikiNode>(null)
};
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("folder catalogs and descriptions", () => {
  it.each([true, false])("lists actual articles without a catalog or placeholder description, catalog present=%s", (hasCatalog) => {
    const html = renderToStaticMarkup(<DocumentPane {...defaults} childrenState={state(hasCatalog ? [child("index.md"), child("article.md")] : [child("article.md")])} />);
    expect(html).toContain("article.md");
    expect(html).not.toContain("Folder note");
    expect(html).not.toContain("Scopes");
    expect(html).not.toContain("Curated catalog");
    expect(html).not.toContain('href="/db/fixture/Knowledge/demo/index.md"');
    expect(html).not.toContain("About this folder");
  });

  it("shows a closed description with correctly resolved relative links", () => {
    const html = renderToStaticMarkup(<DocumentPane {...defaults} folderOverviewNode={state(node("/Knowledge/demo/overview.md", "# Guide\n\n[Read next](article.md)"))} />);
    const document = new DOMParser().parseFromString(html, "text/html");
    expect(document.querySelector("details")?.hasAttribute("open")).toBe(false);
    expect(document.querySelector("summary")?.textContent).toBe("About this folder");
    expect(document.querySelector("details a")?.getAttribute("href")).toBe("/db/fixture/Knowledge/demo/article.md");
    if (process.env.WIKI_FOLDER_FIXTURE_DIR) {
      const dir = resolve(process.env.WIKI_FOLDER_FIXTURE_DIR);
      mkdirSync(dir, { recursive: true });
      writeFileSync(resolve(dir, "folder.html"), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Folder description</title><link rel="stylesheet" href="folder.css"><body class="bg-canvas text-ink"><main class="h-screen">${html}</main></body></html>`);
    }
  });

  it("preserves the children list when the description fails and blocks unsafe editing", () => {
    const failed = state<WikiNode>(null, "Description unavailable");
    const { container, rerender } = render(<DocumentPane {...defaults} folderOverviewNode={failed} />);
    expect(container.textContent).toContain("article.md");
    expect(container.textContent).toContain("Description unavailable");
    rerender(<DocumentPane {...defaults} folderOverviewNode={failed} view="edit" />);
    expect(container.querySelector("textarea")).toBeNull();
    expect(api.write).not.toHaveBeenCalled();
  });

  it.each([true, false])("edits overview.md using its own etag, existing=%s", async (existing) => {
    const overview = existing ? node("/Knowledge/demo/overview.md", "Existing guide") : null;
    const saved = node("/Knowledge/demo/overview.md", "Updated guide");
    const refresh = vi.fn().mockResolvedValue(saved);
    api.write.mockResolvedValue({ node: { path: saved.path, etag: "saved", kind: "file" } });
    const { getByLabelText, getByText } = render(<DocumentPane {...defaults} view="edit" folderOverviewNode={state(overview)} writeIdentity={{} as Identity} currentDatabaseRole="writer" onFolderOverviewSaved={refresh} />);
    fireEvent.change(getByLabelText("Description"), { target: { value: "Updated guide" } });
    fireEvent.click(getByText("Save"));
    await waitFor(() => expect(api.write).toHaveBeenCalledWith("test", expect.anything(), expect.objectContaining({ path: saved.path, content: "Updated guide", expectedEtag: existing ? "etag-existing" : "" })));
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  });

  it("still renders an explicitly opened catalog as a file", () => {
    const html = renderToStaticMarkup(<DocumentPane {...defaults} node={state(node("/Knowledge/demo/index.md", "# Agent catalog"))} />);
    expect(html).toContain("Agent catalog");
  });
});
