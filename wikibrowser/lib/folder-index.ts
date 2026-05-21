// Where: wikibrowser/lib/folder-index.ts
// What: Map folder body UI to the reserved child Markdown node.
// Why: A path cannot be both folder and file, so folder text lives in index.md.
import type { ChildNode } from "@/lib/types";

const FOLDER_INDEX_NAME = "index.md";

export function folderIndexPath(folderPath: string): string {
  return `${folderPath.replace(/\/+$/, "")}/${FOLDER_INDEX_NAME}`;
}

export function isFolderIndexNode(node: Pick<ChildNode, "name" | "path">, parentPath?: string): boolean {
  if (node.name !== FOLDER_INDEX_NAME) return false;
  return parentPath ? node.path === folderIndexPath(parentPath) : node.path.endsWith(`/${FOLDER_INDEX_NAME}`);
}

export function visibleChildren(children: ChildNode[], parentPath?: string): ChildNode[] {
  return children.filter((child) => !isFolderIndexNode(child, parentPath));
}

export function isReservedFolderIndexName(fileName: string): boolean {
  return fileName.toLocaleLowerCase() === FOLDER_INDEX_NAME;
}
