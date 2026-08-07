"use client";

import type { Identity } from "@icp-sdk/core/agent";
import type { FormEvent, ReactNode } from "react";
import { ArrowDownAZ, Check, Ellipsis, FileInput, FilePlus, FolderInput, FolderPlus, MoveRight, Pencil, Trash2, X } from "lucide-react";
import { ExplorerTree } from "@/components/explorer-tree";
import { SourceCapturePanel } from "@/components/source-capture-panel";
import { QueryPanel } from "@/components/query-panel";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { parseExplorerSortOrder, type ExplorerSortOrder } from "@/lib/child-sort";
import { parentPath } from "@/lib/paths";
import type { ChildNode, DatabaseRole, WikiNode } from "@/lib/types";
import { isReservedFolderIndexName, visibleChildren } from "@/lib/folder-index";
import {
  STORE_ROOT_PATHS,
  type ModeTab,
  type PathLoadState
} from "@/lib/wiki-helpers";


export function LeftPane({
  tab,
  canisterId,
  databaseId,
  selectedPath,
  childNodesCache,
  autoExpandExplorer,
  readIdentity,
  effectiveReadIdentity,
  currentNode,
  readIdentityMode,
  databaseCyclesError,
  explorerRevision,
  explorerSortOrder,
  onSelectedExplorerNode
}: {
  tab: ModeTab;
  canisterId: string;
  databaseId: string;
  selectedPath: string;
  childNodesCache: { current: Map<string, ChildNode[]> };
  autoExpandExplorer: boolean;
  readIdentity: Identity | null;
  effectiveReadIdentity: Identity | null;
  currentNode: WikiNode | null;
  readIdentityMode: "anonymous" | "user";
  databaseCyclesError: string | null;
  explorerRevision: number;
  explorerSortOrder: ExplorerSortOrder;
  onSelectedExplorerNode: (node: ChildNode) => void;
}) {
  if (tab === "query") {
    return (
      <QueryPanel
        canisterId={canisterId}
        databaseId={databaseId}
        selectedPath={selectedPath}
        currentNode={currentNode}
        readIdentity={effectiveReadIdentity}
        writeIdentity={readIdentity}
        readIdentityMode={readIdentityMode}
        databaseCyclesError={databaseCyclesError}
      />
    );
  }
  if (tab === "source-capture") {
    return (
      <SourceCapturePanel
        canisterId={canisterId}
        databaseId={databaseId}
        readIdentity={readIdentity}
        databaseCyclesError={databaseCyclesError}
      />
    );
  }
  return (
    <ExplorerTree
      key={explorerRevision}
      canisterId={canisterId}
      databaseId={databaseId}
      selectedPath={selectedPath}
      autoExpandSelected={autoExpandExplorer}
      readIdentity={effectiveReadIdentity}
      childNodesCache={childNodesCache}
      sortOrder={explorerSortOrder}
      onSelectedNode={onSelectedExplorerNode}
    />
  );
}

export function ExplorerHeaderActions({
  sortOrder,
  fileDisabled,
  folderDisabled,
  renameDisabled,
  moveDisabled,
  deleteDisabled,
  importDisabled,
  fileTitle,
  folderTitle,
  renameTitle,
  moveTitle,
  deleteTitle,
  importFilesTitle,
  importFolderTitle,
  onSortOrderChange,
  onNewFile,
  onNewFolder,
  onRename,
  onMove,
  onDelete,
  onImportFiles,
  onImportFolder
}: {
  sortOrder: ExplorerSortOrder;
  fileDisabled: boolean;
  folderDisabled: boolean;
  renameDisabled: boolean;
  moveDisabled: boolean;
  deleteDisabled: boolean;
  importDisabled: boolean;
  fileTitle: string;
  folderTitle: string;
  renameTitle: string;
  moveTitle: string;
  deleteTitle: string;
  importFilesTitle: string;
  importFolderTitle: string;
  onSortOrderChange: (order: ExplorerSortOrder) => void;
  onNewFile: () => void;
  onNewFolder: () => void;
  onRename: () => void;
  onMove: () => void;
  onDelete: () => void;
  onImportFiles: () => void;
  onImportFolder: () => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <Select value={sortOrder} onValueChange={(value) => onSortOrderChange(parseExplorerSortOrder(value))}>
        <Tooltip>
          <TooltipTrigger asChild>
            <SelectTrigger
              aria-label="Sort Explorer"
              className="h-8 w-8 justify-center rounded-xl border-0 px-0 text-muted shadow-none hover:bg-accentSoft hover:text-accentText focus:ring-1 [&>svg:last-child]:hidden"
            >
              <ArrowDownAZ aria-hidden="true" size={15} />
            </SelectTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <p>{explorerSortLabel(sortOrder)}</p>
          </TooltipContent>
        </Tooltip>
        <SelectContent align="end">
          <SelectItem value="name-asc">Name (A–Z)</SelectItem>
          <SelectItem value="name-desc">Name (Z–A)</SelectItem>
          <SelectItem value="modified-desc">Date modified (newest)</SelectItem>
          <SelectItem value="modified-asc">Date modified (oldest)</SelectItem>
          <SelectItem value="size-desc">Size (largest)</SelectItem>
          <SelectItem value="size-asc">Size (smallest)</SelectItem>
        </SelectContent>
      </Select>
      <ExplorerActionButton
        onClick={onNewFile}
        disabled={fileDisabled}
        title={fileTitle}
        aria-label="New Markdown file"
      >
        <FilePlus size={15} />
      </ExplorerActionButton>
      <ExplorerActionButton
        onClick={onNewFolder}
        disabled={folderDisabled}
        title={folderTitle}
        aria-label="New folder"
      >
        <FolderPlus size={15} />
      </ExplorerActionButton>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 rounded-xl text-muted hover:bg-accentSoft hover:text-accentText"
            aria-label="More Explorer actions"
            title="More Explorer actions"
          >
            <Ellipsis aria-hidden="true" size={15} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem disabled={importDisabled} title={importFilesTitle} onSelect={onImportFiles}>
            <FileInput aria-hidden="true" size={14} />
            Import local files
          </DropdownMenuItem>
          <DropdownMenuItem disabled={importDisabled} title={importFolderTitle} onSelect={onImportFolder}>
            <FolderInput aria-hidden="true" size={14} />
            Import local folder
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={renameDisabled} title={renameTitle} onSelect={onRename}>
            <Pencil aria-hidden="true" size={14} />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem disabled={moveDisabled} title={moveTitle} onSelect={onMove}>
            <MoveRight aria-hidden="true" size={14} />
            Move
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={deleteDisabled}
            title={deleteTitle}
            className="text-red-700 focus:bg-red-50 focus:text-red-700"
            onSelect={onDelete}
          >
            <Trash2 aria-hidden="true" size={14} />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function explorerSortLabel(order: ExplorerSortOrder): string {
  switch (order) {
    case "name-asc": return "Sort: Name (A–Z)";
    case "name-desc": return "Sort: Name (Z–A)";
    case "modified-desc": return "Sort: Date modified (newest)";
    case "modified-asc": return "Sort: Date modified (oldest)";
    case "size-desc": return "Sort: Size (largest)";
    case "size-asc": return "Sort: Size (smallest)";
  }
}

function ExplorerActionButton({
  children,
  disabled,
  title,
  onClick,
  "aria-label": ariaLabel
}: {
  children: ReactNode;
  disabled: boolean;
  title: string;
  onClick: () => void;
  "aria-label": string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 rounded-xl text-muted hover:bg-accentSoft hover:text-accentText disabled:cursor-not-allowed disabled:opacity-40"
            onClick={onClick}
            disabled={disabled}
            aria-label={ariaLabel}
          >
            {children}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <p>{title}</p>
      </TooltipContent>
    </Tooltip>
  );
}

export function ExplorerCreateForm({
  mode,
  directoryPath,
  draftName,
  error,
  busy,
  onCancel,
  onChange,
  onSubmit
}: {
  mode: "file" | "folder" | "rename";
  directoryPath: string;
  draftName: string;
  error: string | null;
  busy: boolean;
  onCancel: () => void;
  onChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const label = mode === "rename" ? "Rename selected node" : mode === "folder" ? `New folder in ${directoryPath}` : `New file in ${directoryPath}`;
  const placeholder = mode === "folder" ? "project" : "note.md";
  const submitLabel = mode === "rename" ? "Rename selected node" : mode === "folder" ? "Create folder" : "Create Markdown file";
  return (
    <form className="border-b border-line px-3 py-2" onSubmit={onSubmit}>
      <div className="mb-1 truncate text-[11px] text-muted">{label}</div>
      <div className="flex items-center gap-1">
        <input
          className="min-w-0 flex-1 rounded-md border border-line bg-white px-2 py-1 text-xs outline-none focus:border-accent"
          value={draftName}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          aria-label={label}
        />
        <button
          type="submit"
          className="rounded-md p-1 text-muted hover:bg-accentSoft hover:text-accentText disabled:cursor-not-allowed disabled:opacity-40"
          disabled={busy}
          aria-label={submitLabel}
          title={submitLabel}
        >
          <Check size={15} />
        </button>
        <button
          type="button"
          className="rounded-md p-1 text-muted hover:bg-accentSoft hover:text-accentText disabled:cursor-not-allowed disabled:opacity-40"
          onClick={onCancel}
          disabled={busy}
          aria-label="Cancel Explorer action"
          title="Cancel"
        >
          <X size={15} />
        </button>
      </div>
      {error ? <div className="mt-1 text-xs text-red-600">{error}</div> : null}
    </form>
  );
}

export function ExplorerMoveForm({
  target,
  folders,
  value,
  error,
  busy,
  onCancel,
  onChange,
  onSubmit
}: {
  target: ChildNode;
  folders: string[];
  value: string;
  error: string | null;
  busy: boolean;
  onCancel: () => void;
  onChange: (value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <div className="border-b border-line px-3 py-2">
      <div className="mb-1 truncate text-[11px] text-muted">Move {target.path}</div>
      <div className="flex items-center gap-1">
        <select
          className="min-w-0 flex-1 rounded-md border border-line bg-white px-2 py-1 text-xs outline-none focus:border-accent"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-label="Move destination folder"
        >
          {folders.map((folder) => (
            <option key={folder} value={folder}>
              {folder}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="rounded-md p-1 text-muted hover:bg-accentSoft hover:text-accentText disabled:cursor-not-allowed disabled:opacity-40"
          disabled={busy || !value}
          aria-label="Move selected node"
          title="Move selected node"
          onClick={onSubmit}
        >
          <Check size={15} />
        </button>
        <button
          type="button"
          className="rounded-md p-1 text-muted hover:bg-accentSoft hover:text-accentText disabled:cursor-not-allowed disabled:opacity-40"
          onClick={onCancel}
          disabled={busy}
          aria-label="Cancel move"
          title="Cancel"
        >
          <X size={15} />
        </button>
      </div>
      {error ? <div className="mt-1 text-xs text-red-600">{error}</div> : null}
    </div>
  );
}

export function ExplorerActionError({ message }: { message: string }) {
  return <div className="border-b border-line px-3 py-2 text-xs text-red-600">{message}</div>;
}

export function wikiMarkdownChildPath(directoryPath: string, fileName: string): string {
  const markdownFileName = normalizeMarkdownFileName(fileName);
  if (!markdownFileName) throw new Error("Enter a Markdown file name, not a path.");
  if (isReservedFolderIndexName(markdownFileName)) throw new Error("Use folder Edit to create index.md.");
  return wikiChildPath(directoryPath, markdownFileName, "Markdown files");
}

export function wikiChildPath(directoryPath: string, name: string, label: string): string {
  if (!isDatabasePath(directoryPath)) {
    throw new Error(`${label} can only be created under a database path.`);
  }
  return childPath(directoryPath, name);
}

export function normalizeMarkdownFileName(fileName: string): string | null {
  const trimmed = fileName.trim();
  if (!trimmed || trimmed.includes("/") || trimmed === "." || trimmed === ".." || trimmed === ".md") {
    return null;
  }
  return trimmed.endsWith(".md") ? trimmed : `${trimmed}.md`;
}

export function normalizePathSegment(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed || trimmed.includes("/") || trimmed === "." || trimmed === "..") {
    return null;
  }
  return trimmed;
}

export function createDirectoryForExplorerNode(node: ChildNode | null): string | null {
  if (!node) {
    return null;
  }
  if ((node.kind === "directory" || node.kind === "folder") && isDatabasePath(node.path)) {
    return node.path;
  }
  if (node.kind === "file" && isDatabasePath(node.path)) {
    return parentPath(node.path);
  }
  return null;
}

export function isMutableExplorerNode(node: ChildNode): boolean {
  if (node.isVirtual || !node.etag || isProtectedRootFolder(node.path)) return false;
  return (node.kind === "file" && node.path.endsWith(".md")) || node.kind === "folder";
}

export function isDeletableExplorerNode(node: ChildNode, loadedChildren?: ChildNode[]): boolean {
  if (node.isVirtual || !node.etag || isProtectedRootFolder(node.path)) return false;
  if (node.kind === "folder") {
    return loadedChildren ? visibleChildren(loadedChildren, node.path).length === 0 : !node.hasChildren;
  }
  return (node.kind === "file" && node.path.endsWith(".md")) || node.kind === "source";
}

export function loadedWikiFolders(cache: Map<string, ChildNode[]>, excludedNode: ChildNode | null): string[] {
  const paths = new Set<string>(STORE_ROOT_PATHS);
  for (const children of cache.values()) {
    for (const child of children) {
      if (child.kind === "folder" && isDatabasePath(child.path) && !isExcludedMoveFolder(child.path, excludedNode)) {
        paths.add(child.path);
      }
    }
  }
  const excludedParent = excludedNode ? parentPath(excludedNode.path) : null;
  if (excludedParent && isDatabasePath(excludedParent)) {
    paths.add(excludedParent);
  }
  return [...paths].sort((left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" }));
}

export function sameStringList(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isExcludedMoveFolder(path: string, node: ChildNode | null): boolean {
  if (!node) return false;
  if (node.kind !== "folder") return false;
  return path === node.path || path.startsWith(`${node.path}/`);
}

function isDatabasePath(path: string): boolean {
  return STORE_ROOT_PATHS.some((root) => path === root || path.startsWith(`${root}/`));
}

export function childPath(directoryPath: string, name: string): string {
  return directoryPath === "/" ? `/${name}` : `${directoryPath}/${name}`;
}

function isProtectedRootFolder(path: string): boolean {
  return STORE_ROOT_PATHS.some((root) => path === root);
}

export function writeDisabledReason(
  writeIdentity: Identity | null,
  currentDatabaseRole: DatabaseRole | null,
  databaseRoleError: string | null,
  databaseCyclesError: string | null
): string | null {
  if (!writeIdentity) return "Login with Internet Identity to change files.";
  if (databaseRoleError) return databaseRoleError;
  if (!currentDatabaseRole) return "Database role unavailable.";
  if (currentDatabaseRole !== "writer" && currentDatabaseRole !== "owner") return "Writer or owner access required.";
  if (databaseCyclesError) return databaseCyclesError;
  return null;
}

export function explorerNodeFromSelection(
  selectedPath: string,
  node: PathLoadState<WikiNode>,
  children: PathLoadState<ChildNode[]>
): ChildNode | null {
  if (node.data) {
    return {
      path: node.data.path,
      name: pathName(node.data.path),
      kind: node.data.kind,
      updatedAt: node.data.updatedAt,
      etag: node.data.etag,
      sizeBytes: null,
      isVirtual: false,
      hasChildren: node.data.kind === "folder" && Boolean(children.data && visibleChildren(children.data, node.data.path).length),
      isPublished: false
    };
  }
  if (children.data) {
    return {
      path: selectedPath,
      name: pathName(selectedPath),
      kind: "directory",
      updatedAt: null,
      etag: null,
      sizeBytes: null,
      isVirtual: true,
      hasChildren: true,
      isPublished: false
    };
  }
  return null;
}

function pathName(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}
