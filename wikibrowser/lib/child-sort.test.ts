import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXPLORER_SORT_ORDER,
  parseExplorerSortOrder,
  sortChildNodes,
  sortExplorerChildNodes,
  type ExplorerSortOrder
} from "@/lib/child-sort";
import type { ChildNode, NodeEntryKind } from "@/lib/types";

const HUGE_SIZE = "900719925474099312345";

describe("sortChildNodes", () => {
  it("preserves input order when names and paths differ only by case", () => {
    const nodes = [
      child("/Knowledge/Beta.md", "Beta.md", "file", "10", "10"),
      child("/Knowledge/beta.md", "beta.md", "file", "10", "10")
    ];

    expect(sortChildNodes(nodes).map((node) => node.path)).toEqual([
      "/Knowledge/Beta.md",
      "/Knowledge/beta.md"
    ]);
  });
});

describe("sortExplorerChildNodes", () => {
  const nodes = [
    child("/Knowledge/zulu", "zulu", "folder", "300", null),
    child("/Knowledge/beta.md", "beta.md", "file", "200", "20"),
    child("/Knowledge/alpha", "alpha", "folder", "100", null),
    child("/Knowledge/alpha.md", "alpha.md", "file", "100", HUGE_SIZE),
    child("/Knowledge/unknown.md", "unknown.md", "file", null, null)
  ];

  it.each<[ExplorerSortOrder, string[]]>([
    ["name-asc", ["alpha", "zulu", "alpha.md", "beta.md", "unknown.md"]],
    ["name-desc", ["zulu", "alpha", "unknown.md", "beta.md", "alpha.md"]],
    ["modified-desc", ["zulu", "alpha", "beta.md", "alpha.md", "unknown.md"]],
    ["modified-asc", ["alpha", "zulu", "alpha.md", "beta.md", "unknown.md"]],
    ["size-desc", ["alpha.md", "beta.md", "alpha", "unknown.md", "zulu"]],
    ["size-asc", ["beta.md", "alpha.md", "alpha", "unknown.md", "zulu"]]
  ])("sorts %s without mutating the input", (order, expected) => {
    const original = [...nodes];

    expect(sortExplorerChildNodes(nodes, order).map((node) => node.name)).toEqual(expected);
    expect(nodes).toEqual(original);
  });

  it("sorts equal values by name and then path", () => {
    const tied = [
      child("/Knowledge/Beta.md", "Beta.md", "file", "10", "10"),
      child("/Knowledge/alpha.md", "alpha.md", "file", "10", "10"),
      child("/Knowledge/beta.md", "beta.md", "file", "10", "10")
    ];

    expect(sortExplorerChildNodes(tied, "modified-desc").map((node) => node.path)).toEqual([
      "/Knowledge/alpha.md",
      "/Knowledge/beta.md",
      "/Knowledge/Beta.md"
    ]);
    expect(sortExplorerChildNodes(tied, "size-asc").map((node) => node.path)).toEqual([
      "/Knowledge/alpha.md",
      "/Knowledge/beta.md",
      "/Knowledge/Beta.md"
    ]);
  });

  it("treats invalid numeric metadata as missing", () => {
    const invalid = child("/Knowledge/invalid.md", "invalid.md", "file", "invalid", "invalid");
    const valid = child("/Knowledge/valid.md", "valid.md", "file", "1", "1");

    expect(sortExplorerChildNodes([invalid, valid], "modified-asc").map((node) => node.name)).toEqual(["valid.md", "invalid.md"]);
    expect(sortExplorerChildNodes([invalid, valid], "size-desc").map((node) => node.name)).toEqual(["valid.md", "invalid.md"]);
  });
});

describe("parseExplorerSortOrder", () => {
  it.each<ExplorerSortOrder>([
    "name-asc",
    "name-desc",
    "modified-desc",
    "modified-asc",
    "size-desc",
    "size-asc"
  ])("accepts %s", (order) => {
    expect(parseExplorerSortOrder(order)).toBe(order);
  });

  it.each([null, undefined, "", "created-desc", 1])("defaults invalid value %s", (value) => {
    expect(parseExplorerSortOrder(value)).toBe(DEFAULT_EXPLORER_SORT_ORDER);
  });
});

function child(
  path: string,
  name: string,
  kind: NodeEntryKind,
  updatedAt: string | null,
  sizeBytes: string | null
): ChildNode {
  return {
    path,
    name,
    kind,
    updatedAt,
    etag: null,
    sizeBytes,
    isVirtual: false,
    hasChildren: kind === "folder",
    isPublished: false
  };
}
