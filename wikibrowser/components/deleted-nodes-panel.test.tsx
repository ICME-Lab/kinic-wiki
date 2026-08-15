// @vitest-environment jsdom

import type { Identity } from "@icp-sdk/core/agent";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeletedNodesPanel } from "@/components/wiki-browser/explorer-pane";
import type { DeletedNodePage, DeletedNodeSummary } from "@/lib/types";
import { listDeletedNodes } from "@/lib/vfs-client";

vi.mock("@/lib/vfs-client", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/vfs-client")>(),
  listDeletedNodes: vi.fn(),
  restoreNodeVersionAuthenticated: vi.fn()
}));

const identity = {
  getPrincipal: () => ({ toText: () => "aaaaa-aa" })
} as unknown as Identity;

beforeEach(() => {
  vi.mocked(listDeletedNodes).mockReset();
});

afterEach(cleanup);

describe("DeletedNodesPanel", () => {
  it("removes deleted paths and authors immediately after logout", async () => {
    vi.mocked(listDeletedNodes).mockResolvedValue(page("db-a", null));
    const { rerender } = renderPanel("db-a", identity);

    expect(await screen.findByText("/Knowledge/db-a-deleted.md")).toBeTruthy();
    rerender(panelElement("db-a", null));

    expect(screen.getByText("Login as a database member to view deleted pages.")).toBeTruthy();
    expect(screen.queryByText("/Knowledge/db-a-deleted.md")).toBeNull();
    expect(screen.queryByText("db-a-author")).toBeNull();
  });

  it("drops an older-page response when the database changes", async () => {
    const olderA = deferred<DeletedNodePage>();
    const initialB = deferred<DeletedNodePage>();
    vi.mocked(listDeletedNodes).mockImplementation(async (_canisterId, databaseId, _identity, cursor) => {
      if (databaseId === "db-a" && cursor == null) return page("db-a", 10n);
      if (databaseId === "db-a") return olderA.promise;
      return initialB.promise;
    });
    const { rerender } = renderPanel("db-a", identity);
    expect(await screen.findByText("/Knowledge/db-a-deleted.md")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load older deletions" }));

    rerender(panelElement("db-b", identity));
    expect(screen.queryByText("/Knowledge/db-a-deleted.md")).toBeNull();
    expect(screen.getByText("Loading deleted pages…")).toBeTruthy();
    await act(async () => olderA.resolve(page("db-a-older", null)));
    expect(screen.queryByText("/Knowledge/db-a-older-deleted.md")).toBeNull();
    await act(async () => initialB.resolve(page("db-b", null)));

    expect(await screen.findByText("/Knowledge/db-b-deleted.md")).toBeTruthy();
    expect(screen.queryByText("db-a-author")).toBeNull();
  });
});

function renderPanel(databaseId: string, currentIdentity: Identity | null) {
  return render(panelElement(databaseId, currentIdentity));
}

function panelElement(databaseId: string, currentIdentity: Identity | null) {
  return <DeletedNodesPanel canisterId="canister" databaseId={databaseId} identity={currentIdentity} databaseRole="writer" onClose={vi.fn()} onRestored={vi.fn()} />;
}

function page(label: string, nextCursor: bigint | null): DeletedNodePage {
  return { nodes: [deletedNode(label)], nextCursor };
}

function deletedNode(label: string): DeletedNodeSummary {
  return {
    pageId: 7n,
    versionId: 3n,
    path: `/Knowledge/${label}-deleted.md`,
    kind: "file",
    etag: `${label}-etag`,
    blobOid: "89abcdef0123456789abcdef0123456789abcdef",
    nodeCreatedAt: "1",
    nodeUpdatedAt: "2",
    deletedAt: "3",
    deletedBy: `${label}-author`
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}
