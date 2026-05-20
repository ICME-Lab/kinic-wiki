// Where: wikibrowser/lib/child-sort.ts
// What: Keep directory child ordering deterministic for browser views.
// Why: Canister delivery order is not a useful navigation order.
import type { ChildNode } from "@/lib/types";

export function sortChildNodes(children: ChildNode[]): ChildNode[] {
  return [...children].sort(compareChildNodes);
}

function compareChildNodes(left: ChildNode, right: ChildNode): number {
  const kindOrder = childKindOrder(left) - childKindOrder(right);
  if (kindOrder !== 0) {
    return kindOrder;
  }
  const nameOrder = left.name.localeCompare(right.name, undefined, {
    numeric: true,
    sensitivity: "base"
  });
  if (nameOrder !== 0) {
    return nameOrder;
  }
  return left.path.localeCompare(right.path, undefined, {
    numeric: true,
    sensitivity: "base"
  });
}

function childKindOrder(child: ChildNode): number {
  return child.kind === "directory" || child.kind === "folder" ? 0 : 1;
}
