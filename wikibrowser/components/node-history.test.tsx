// @vitest-environment jsdom

import type { Identity } from "@icp-sdk/core/agent";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NodeHistory } from "@/components/node-history";
import type { NodeHistoryEntry, NodeVersion, NodeVersionSummary, WikiNode } from "@/lib/types";
import { listNodeHistory, readNodeVersion } from "@/lib/vfs-client";

vi.mock("@/lib/vfs-client", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/vfs-client")>(),
  listNodeHistory: vi.fn(),
  readNodeVersion: vi.fn(),
  restoreNodeVersionAuthenticated: vi.fn()
}));

const identity = {
  getPrincipal: () => ({ toText: () => "aaaaa-aa" })
} as unknown as Identity;

beforeEach(() => {
  vi.mocked(listNodeHistory).mockReset();
  vi.mocked(readNodeVersion).mockReset();
});

afterEach(cleanup);

describe("NodeHistory", () => {
  it("does not reuse version content from another database with the same ids", async () => {
    vi.mocked(listNodeHistory).mockImplementation(async (_canisterId, databaseId) => historyPage(databaseId));
    vi.mocked(readNodeVersion).mockImplementation(async (_canisterId, databaseId, pageId, versionId) => version(databaseId, pageId, versionId));
    const { rerender } = renderHistory("db-a");

    expect(await screen.findByText("db-a-new")).toBeTruthy();
    rerender(historyElement("db-b"));

    expect(screen.queryByText("db-a-new")).toBeNull();
    expect(await screen.findByText("db-b-new")).toBeTruthy();
    expect(screen.queryByText("db-a-old")).toBeNull();
  });

  it("ignores version reads that finish after the database changes", async () => {
    const pendingA = new Map<bigint, ReturnType<typeof deferred<NodeVersion | null>>>();
    vi.mocked(listNodeHistory).mockImplementation(async (_canisterId, databaseId) => historyPage(databaseId));
    vi.mocked(readNodeVersion).mockImplementation((_canisterId, databaseId, pageId, versionId) => {
      if (databaseId === "db-b") return Promise.resolve(version(databaseId, pageId, versionId));
      const request = deferred<NodeVersion | null>();
      pendingA.set(versionId, request);
      return request.promise;
    });
    const { rerender } = renderHistory("db-a");
    await waitFor(() => expect(pendingA.size).toBe(2));

    rerender(historyElement("db-b"));
    expect(await screen.findByText("db-b-new")).toBeTruthy();
    await act(async () => {
      for (const [versionId, request] of pendingA) request.resolve(version("db-a", 7n, versionId));
    });

    expect(screen.queryByText("db-a-new")).toBeNull();
    expect(screen.queryByText("db-a-old")).toBeNull();
  });
});

function renderHistory(databaseId: string) {
  return render(historyElement(databaseId));
}

function historyElement(databaseId: string) {
  return <NodeHistory canisterId="canister" databaseId={databaseId} node={node()} identity={identity} databaseRole="reader" />;
}

function node(): WikiNode {
  return {
    path: "/Knowledge/history.md",
    kind: "file",
    content: "current",
    createdAt: "1",
    updatedAt: "2",
    etag: "current-etag",
    metadataJson: "{}"
  };
}

function historyPage(databaseId: string) {
  return {
    pageId: 7n,
    entries: [entry(databaseId)],
    nextCursor: null
  };
}

function entry(databaseId: string): NodeHistoryEntry {
  return {
    itemId: 3n,
    changeId: 2n,
    pageId: 7n,
    operation: "write",
    changeKind: "update",
    authorPrincipal: `${databaseId}-author`,
    changedAt: "2",
    beforeVersion: summary(7n, 1n),
    afterVersion: summary(7n, 2n)
  };
}

function summary(pageId: bigint, versionId: bigint): NodeVersionSummary {
  return {
    pageId,
    versionId,
    path: "/Knowledge/history.md",
    kind: "file",
    etag: `etag-${versionId.toString()}`,
    nodeCreatedAt: "1",
    nodeUpdatedAt: versionId.toString()
  };
}

function version(databaseId: string, pageId: bigint, versionId: bigint): NodeVersion {
  return {
    summary: summary(pageId, versionId),
    content: `${databaseId}-${versionId === 1n ? "old" : "new"}`,
    metadataJson: "{}"
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}
