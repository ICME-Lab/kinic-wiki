// Where: wikibrowser/lib/child-sort.ts
// What: Keep directory child ordering deterministic for browser views.
// Why: Canister delivery order is not a useful navigation order.
import type { ChildNode } from "@/lib/types";

export const DEFAULT_EXPLORER_SORT_ORDER = "name-asc" as const;

export type ExplorerSortOrder =
  | "name-asc"
  | "name-desc"
  | "modified-desc"
  | "modified-asc"
  | "size-desc"
  | "size-asc";

const EXPLORER_SORT_ORDERS: ReadonlySet<string> = new Set<ExplorerSortOrder>([
  "name-asc",
  "name-desc",
  "modified-desc",
  "modified-asc",
  "size-desc",
  "size-asc"
]);

export function sortChildNodes(children: ChildNode[]): ChildNode[] {
  return [...children].sort(compareChildNodes);
}

export function parseExplorerSortOrder(value: unknown): ExplorerSortOrder {
  return typeof value === "string" && EXPLORER_SORT_ORDERS.has(value)
    ? value as ExplorerSortOrder
    : DEFAULT_EXPLORER_SORT_ORDER;
}

export function sortExplorerChildNodes(children: ChildNode[], order: ExplorerSortOrder): ChildNode[] {
  return [...children].sort((left, right) => compareExplorerChildNodes(left, right, order));
}

function compareExplorerChildNodes(left: ChildNode, right: ChildNode, order: ExplorerSortOrder): number {
  if (order.startsWith("name-") || order.startsWith("modified-")) {
    const kindOrder = childKindOrder(left) - childKindOrder(right);
    if (kindOrder !== 0) return kindOrder;
  }

  if (order === "name-asc" || order === "name-desc") {
    const nameOrder = compareNames(left, right);
    if (nameOrder !== 0) return order === "name-asc" ? nameOrder : -nameOrder;
    return compareExplorerPaths(left, right);
  }

  const valueOrder = order.startsWith("modified-")
    ? compareOptionalIntegers(left.updatedAt, right.updatedAt, order === "modified-asc")
    : compareOptionalIntegers(left.sizeBytes, right.sizeBytes, order === "size-asc");
  if (valueOrder !== 0) return valueOrder;

  const nameOrder = compareNames(left, right);
  return nameOrder !== 0 ? nameOrder : compareExplorerPaths(left, right);
}

function compareOptionalIntegers(left: string | null, right: string | null, ascending: boolean): number {
  const leftValue = parseInteger(left);
  const rightValue = parseInteger(right);
  if (leftValue === null && rightValue === null) return 0;
  if (leftValue === null) return 1;
  if (rightValue === null) return -1;
  if (leftValue === rightValue) return 0;
  const order = leftValue < rightValue ? -1 : 1;
  return ascending ? order : -order;
}

function parseInteger(value: string | null): bigint | null {
  if (value === null) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function compareChildNodes(left: ChildNode, right: ChildNode): number {
  const kindOrder = childKindOrder(left) - childKindOrder(right);
  if (kindOrder !== 0) {
    return kindOrder;
  }
  const nameOrder = compareNames(left, right);
  if (nameOrder !== 0) {
    return nameOrder;
  }
  return compareBrowserPaths(left, right);
}

function compareNames(left: ChildNode, right: ChildNode): number {
  return left.name.localeCompare(right.name, undefined, {
    numeric: true,
    sensitivity: "base"
  });
}

function compareBrowserPaths(left: ChildNode, right: ChildNode): number {
  return left.path.localeCompare(right.path, undefined, {
    numeric: true,
    sensitivity: "base"
  });
}

function compareExplorerPaths(left: ChildNode, right: ChildNode): number {
  return left.path.localeCompare(right.path, undefined, {
    numeric: true,
    sensitivity: "variant"
  });
}

function childKindOrder(child: ChildNode): number {
  return child.kind === "directory" || child.kind === "folder" ? 0 : 1;
}
