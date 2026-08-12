import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Identity } from "@icp-sdk/core/agent";

const mocks = vi.hoisted(() => ({ writeNodes: vi.fn() }));

vi.mock("@/lib/vfs-client/actor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/vfs-client/actor")>();
  return {
    ...actual,
    createAuthenticatedActor: async () => ({ write_nodes: mocks.writeNodes })
  };
});

import { writeNodesAuthenticated } from "@/lib/vfs-client";
import { ApiError } from "@/lib/wiki-helpers";

describe("writeNodesAuthenticated", () => {
  beforeEach(() => mocks.writeNodes.mockReset());

  it("maps folder and replacement items to the existing Candid contract", async () => {
    mocks.writeNodes.mockResolvedValue({
      Ok: [
        { created: true, node: { path: "/Knowledge/notes", kind: { Folder: null }, updated_at: 1n, etag: "folder" } },
        { created: false, node: { path: "/Knowledge/notes/a.md", kind: { File: null }, updated_at: 2n, etag: "file" } }
      ]
    });

    const result = await writeNodesAuthenticated("aaaaa-aa", {} as Identity, {
      databaseId: "db-1",
      nodes: [
        { path: "/Knowledge/notes", kind: "folder", content: "", metadataJson: "{}", expectedEtag: null },
        { path: "/Knowledge/notes/a.md", kind: "file", content: "new", metadataJson: "{}", expectedEtag: "old-etag" }
      ]
    });

    expect(mocks.writeNodes).toHaveBeenCalledWith({
      database_id: "db-1",
      nodes: [
        { path: "/Knowledge/notes", kind: { Folder: null }, content: "", metadata_json: "{}", expected_etag: [] },
        { path: "/Knowledge/notes/a.md", kind: { File: null }, content: "new", metadata_json: "{}", expected_etag: ["old-etag"] }
      ]
    });
    expect(result).toEqual([
      { created: true, node: { path: "/Knowledge/notes", kind: "folder", updatedAt: "1", etag: "folder" } },
      { created: false, node: { path: "/Knowledge/notes/a.md", kind: "file", updatedAt: "2", etag: "file" } }
    ]);
  });

  it.each([
    ["EtagConflict", 409, "etag_conflict"],
    ["NotFound", 404, "node_not_found"],
    ["Forbidden", 403, "forbidden"],
    ["WriteUnavailable", 503, "write_unavailable"],
    ["InvalidOperation", 400, "invalid_operation"]
  ] as const)("preserves the %s mutation error", async (mutationCode, status, code) => {
    mocks.writeNodes.mockResolvedValue({
      Err: {
        code: { [mutationCode]: null },
        message: "structured mutation failure",
        failed_index: [0],
        conflict_path: ["/Knowledge/notes/a.md"]
      }
    });
    const error = await writeNodesAuthenticated("aaaaa-aa", {} as Identity, { databaseId: "db-1", nodes: [] }).catch(
      (caught: unknown) => caught
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      message: "structured mutation failure",
      status,
      code,
      mutationCode,
      failedIndex: 0,
      conflictPath: "/Knowledge/notes/a.md"
    });
  });
});
