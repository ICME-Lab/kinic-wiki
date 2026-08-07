import { describe, expect, it } from "vitest";
import { KinicMutationError, unwrapMutation } from "../src/vfs.js";

describe("structured node mutation errors", () => {
  it("decodes the Candid error without inspecting its message", () => {
    let thrown: unknown;
    try {
      unwrapMutation({
        Err: {
          code: { NotFound: null },
          message: "node does not exist: /Memory/expected_etag.md",
          failed_index: [2],
          conflict_path: []
        }
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(KinicMutationError);
    expect(thrown).toMatchObject({
      code: "not_found",
      failedIndex: 2,
      conflictPath: null,
      message: "node does not exist: /Memory/expected_etag.md"
    });
  });

  it("keeps the canister-provided conflict path", () => {
    expect(() =>
      unwrapMutation({
        Err: {
          code: { EtagConflict: null },
          message: "folder index changed",
          failed_index: [0],
          conflict_path: ["/Memory/topic/index.md"]
        }
      })
    ).toThrowError(expect.objectContaining({
      code: "etag_conflict",
      failedIndex: 0,
      conflictPath: "/Memory/topic/index.md"
    }));
  });
});
