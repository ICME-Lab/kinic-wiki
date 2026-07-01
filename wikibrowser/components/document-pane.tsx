"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { Fragment, useState } from "react";
import type { ReactNode } from "react";
import type { Identity } from "@icp-sdk/core/agent";
import { FileCode, FileText, Folder, Loader2, Route } from "lucide-react";
import { hrefForPath, hrefForSearch } from "@/lib/paths";
import { splitMarkdownPreviewSections } from "@/lib/markdown-sections";
import type { ChildNode, DatabaseRole, WikiNode } from "@/lib/types";
import { isKnowledgeSourcePath, type LoadState, type ModeTab, type PathLoadState, type ViewMode } from "@/lib/wiki-helpers";
import { folderIndexPath, visibleChildren } from "@/lib/folder-index";
import { ErrorBox } from "@/components/panel";
import type { EditorSaveState } from "@/components/markdown-editor";
import { MarkdownEditDocument } from "@/components/markdown-edit-document";

const LARGE_CONTENT_BYTES = 1024 * 1024;
const RAW_INITIAL_CHARS = 64 * 1024;
const RAW_LOAD_STEP_CHARS = 64 * 1024;
const MarkdownPreview = dynamic(() => import("@/components/markdown-preview").then((module) => module.MarkdownPreview), {
  ssr: false,
  loading: () => <p className="text-sm text-muted">Loading markdown preview...</p>
});

export type DocumentEditState = {
  dirty: boolean;
  saveState: EditorSaveState;
};

export function DocumentHeader({
  canisterId,
  databaseId,
  path,
  view,
  onViewChange,
  isDirectory,
  canEditDirectory,
  editState,
  rawContent
}: {
  canisterId: string;
  databaseId: string;
  path: string;
  view: ViewMode;
  onViewChange: (view: ViewMode) => void;
  isDirectory: boolean;
  canEditDirectory: boolean;
  editState: DocumentEditState;
  rawContent: string | null;
}) {
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  async function copyText(label: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopyStatus(`${label} copied`);
    } catch {
      setCopyStatus(`${label} copy failed`);
    }
  }
  const hasStatusBadges = view === "edit" || copyStatus !== null;
  return (
    <div className="border-b border-line bg-white px-2 py-3 sm:px-5">
      <div className="flex min-h-9 items-center gap-1 overflow-x-auto whitespace-nowrap sm:min-h-10 sm:gap-2 lg:justify-between lg:overflow-visible">
        <div className="flex min-w-0 shrink-0 items-center gap-1 sm:gap-2">
          <div className="hidden min-w-[88px] max-w-[34vw] shrink-0 sm:block sm:max-w-[52vw] lg:max-w-full">
            <DocumentHeaderPath canisterId={canisterId} databaseId={databaseId} path={path} />
          </div>
          <div className="flex h-9 shrink-0 rounded-2xl border border-line bg-white p-1 text-xs shadow-[0_4px_10px_#14142b0a] sm:h-10">
            <button
              aria-label="Copy path"
              className="inline-flex size-7 items-center justify-center rounded-lg text-muted hover:bg-paper hover:text-ink sm:size-8"
              title="Copy path"
              type="button"
              onClick={() => void copyText("Path", path)}
            >
              <Route aria-hidden="true" size={15} />
            </button>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1 sm:gap-2">
          <div className="flex shrink-0 rounded-2xl border border-line bg-white p-1 text-xs shadow-[0_4px_10px_#14142b0a] sm:text-sm">
            <ViewButton active={view === "preview"} label="Preview" onClick={() => onViewChange("preview")} />
            <ViewButton active={view === "raw"} label="Raw" onClick={() => onViewChange("raw")} />
            {!isDirectory || canEditDirectory ? <ViewButton active={view === "edit"} label="Edit" onClick={() => onViewChange("edit")} /> : null}
          </div>
          {rawContent !== null ? (
            <div className="flex h-9 shrink-0 rounded-2xl border border-line bg-white p-1 text-xs shadow-[0_4px_10px_#14142b0a] sm:h-10">
              <button
                aria-label="Copy raw"
                className="inline-flex size-7 items-center justify-center rounded-lg text-muted hover:bg-paper hover:text-ink sm:size-8"
                title="Copy raw"
                type="button"
                onClick={() => void copyText("Raw", rawContent)}
              >
                <FileCode aria-hidden="true" size={15} />
              </button>
            </div>
          ) : null}
        </div>
      </div>
      {hasStatusBadges ? (
        <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1">
          {view === "edit" ? <HeaderBadge label="Editing" tone="blue" /> : null}
          {view === "edit" && editState.dirty ? <HeaderBadge label="Unsaved" tone="yellow" /> : null}
          {view === "edit" && editState.saveState === "saving" ? <HeaderBadge label="Saving" tone="blue" /> : null}
          {view === "edit" && editState.saveState === "saved" ? <HeaderBadge label="Saved" tone="green" /> : null}
          {copyStatus ? <HeaderBadge label={copyStatus} tone={copyStatus.endsWith("failed") ? "yellow" : "green"} /> : null}
        </div>
      ) : null}
    </div>
  );
}

function DocumentHeaderPath({
  canisterId,
  databaseId,
  path
}: {
  canisterId: string;
  databaseId: string;
  path: string;
}) {
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0) {
    return <div className="flex h-9 w-fit min-w-0 max-w-full items-center rounded-2xl border border-line bg-white px-2 font-mono text-xs font-medium text-ink shadow-[0_4px_10px_#14142b0a] sm:h-10 sm:px-3">/</div>;
  }
  return (
    <nav className="flex h-9 w-fit min-w-0 max-w-full items-center gap-1 overflow-x-auto rounded-2xl border border-line bg-white px-2 font-mono text-xs shadow-[0_4px_10px_#14142b0a] sm:h-10 sm:px-3" aria-label="Current knowledge path">
      {segments.map((segment, index) => {
        const crumbPath = `/${segments.slice(0, index + 1).join("/")}`;
        const last = index === segments.length - 1;
        return (
          <Fragment key={crumbPath}>
            {index > 0 ? <span className="shrink-0 text-muted">/</span> : null}
            {last ? (
              <span className="max-w-[24rem] truncate font-medium text-ink">{segment}</span>
            ) : (
              <Link
                className="max-w-[14rem] shrink-0 truncate rounded px-1 py-0.5 text-muted no-underline hover:bg-white hover:text-ink"
                href={hrefForPath(canisterId, databaseId, crumbPath)}
              >
                {segment}
              </Link>
            )}
          </Fragment>
        );
      })}
    </nav>
  );
}

export function DocumentPane({
  databaseId,
  node,
  folderIndexNode,
  childrenState,
  view,
  canisterId,
  authPrompt,
  authReady,
  onLogin,
  writeIdentity,
  currentDatabaseRole,
  databaseRoleError,
  databaseCyclesError,
  onNodeSaved,
  onFolderIndexSaved,
  onEditStateChange,
  tab
}: {
  node: PathLoadState<WikiNode>;
  folderIndexNode: PathLoadState<WikiNode>;
  childrenState: PathLoadState<ChildNode[]>;
  view: ViewMode;
  canisterId: string;
  databaseId: string;
  authPrompt?: "private" | null;
  authReady?: boolean;
  onLogin?: () => void;
  writeIdentity?: Identity | null;
  currentDatabaseRole?: DatabaseRole | null;
  databaseRoleError?: string | null;
  databaseCyclesError?: string | null;
  onNodeSaved?: () => Promise<WikiNode>;
  onFolderIndexSaved?: () => Promise<WikiNode>;
  onEditStateChange?: (state: DocumentEditState) => void;
  tab?: ModeTab;
}) {
  if (node.loading && childrenState.loading) return <PaneBody><LoadingBlock /></PaneBody>;
  if (authPrompt && onLogin) {
    return <PaneBody className="p-6"><AuthRequiredState authReady={Boolean(authReady)} mode={authPrompt} onLogin={onLogin} /></PaneBody>;
  }
  if (node.data?.kind === "folder") {
    return (
      <PaneBody>
        <FolderDocument
          folder={node.data}
          folderIndexNode={folderIndexNode}
          childrenState={childrenState}
          view={view}
          canisterId={canisterId}
          databaseId={databaseId}
          tab={tab}
          authReady={Boolean(authReady)}
          onLogin={onLogin}
          writeIdentity={writeIdentity ?? null}
          currentDatabaseRole={currentDatabaseRole ?? null}
          databaseRoleError={databaseRoleError ?? null}
          databaseCyclesError={databaseCyclesError ?? null}
          onFolderIndexSaved={onFolderIndexSaved}
          onEditStateChange={onEditStateChange}
        />
      </PaneBody>
    );
  }
  if (node.data) {
    return (
      <PaneBody>
        <NodeDocument
          node={node.data}
          view={view}
          canisterId={canisterId}
          databaseId={databaseId}
          authReady={Boolean(authReady)}
          onLogin={onLogin}
          writeIdentity={writeIdentity ?? null}
          currentDatabaseRole={currentDatabaseRole ?? null}
          databaseRoleError={databaseRoleError ?? null}
          databaseCyclesError={databaseCyclesError ?? null}
          onNodeSaved={onNodeSaved}
          onEditStateChange={onEditStateChange}
          tab={tab}
        />
      </PaneBody>
    );
  }
  if (childrenState.data) {
    return (
      <PaneBody>
        <DirectoryDocument childrenState={childrenState} canisterId={canisterId} databaseId={databaseId} parentPath={childrenState.path} />
      </PaneBody>
    );
  }
  if (isVfsNotFound(node.error, childrenState.error)) {
    return <PaneBody><NotFoundState path={node.path} canisterId={canisterId} databaseId={databaseId} /></PaneBody>;
  }
  return (
    <PaneBody className="p-6">
      <ErrorBox
        message={node.error ?? childrenState.error ?? "Unable to load node"}
        hint={node.hint ?? childrenState.hint}
      />
    </PaneBody>
  );
}

function AuthRequiredState({ authReady, onLogin }: { authReady: boolean; mode: "private"; onLogin: () => void }) {
  return (
    <div className="flex h-full items-center justify-center">
      <section className="max-w-xl rounded-2xl border border-line bg-paper p-6 shadow-sm">
        <p className="font-mono text-xs uppercase tracking-[0.18em] text-muted">Private database</p>
        <h3 className="mt-3 text-2xl font-semibold tracking-[-0.04em] text-ink">Login required</h3>
        <p className="mt-3 text-sm leading-6 text-muted">This database is not public. Login with Internet Identity to read databases linked to your principal.</p>
        <button
          className="mt-5 rounded-2xl border border-action bg-action px-4 py-2 text-sm font-bold text-white hover:-translate-y-[3px] hover:border-accent hover:bg-accent disabled:cursor-not-allowed disabled:translate-y-0 disabled:opacity-60"
          disabled={!authReady}
          data-tid="login-button"
          type="button"
          onClick={onLogin}
        >
          Login with Internet Identity
        </button>
      </section>
    </div>
  );
}

function PaneBody({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`min-h-0 flex-1 ${className}`}>{children}</div>;
}

function NotFoundState({
  path,
  canisterId,
  databaseId
}: {
  path: string;
  canisterId: string;
  databaseId: string;
}) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <section className="max-w-xl rounded-2xl border border-line bg-paper p-6 shadow-sm">
        <p className="font-mono text-xs uppercase tracking-[0.18em] text-muted">Not found</p>
        <h3 className="mt-3 text-2xl font-semibold tracking-[-0.04em] text-ink">No knowledge node at this path</h3>
        <p className="mt-3 break-all font-mono text-xs text-muted">{path}</p>
        <div className="mt-5 flex flex-wrap gap-2 text-sm">
          <Link
            className="rounded-2xl bg-action px-3 py-2 font-bold text-white no-underline hover:bg-accent"
            href={hrefForPath(canisterId, databaseId, "/Knowledge")}
          >
            Open /Knowledge
          </Link>
          <Link
            className="rounded-lg border border-line bg-white px-3 py-2 no-underline"
            href={hrefForPath(canisterId, databaseId, "/Sources")}
          >
            Open /Sources
          </Link>
          <Link className="rounded-lg border border-line bg-white px-3 py-2 no-underline" href={hrefForSearch(canisterId, databaseId, path.split("/").filter(Boolean).at(-1) ?? path, "path")}>
            Search this path
          </Link>
        </div>
      </section>
    </div>
  );
}

function NodeDocument({
  node,
  view,
  canisterId,
  databaseId,
  tab,
  authReady,
  onLogin,
  writeIdentity,
  currentDatabaseRole,
  databaseRoleError,
  databaseCyclesError,
  onNodeSaved,
  onEditStateChange
}: {
  node: WikiNode;
  view: ViewMode;
  canisterId: string;
  databaseId: string;
  tab?: ModeTab;
  authReady: boolean;
  onLogin?: () => void;
  writeIdentity: Identity | null;
  currentDatabaseRole: DatabaseRole | null;
  databaseRoleError: string | null;
  databaseCyclesError: string | null;
  onNodeSaved?: () => Promise<WikiNode>;
  onEditStateChange?: (state: DocumentEditState) => void;
}) {
  const contentBytes = new TextEncoder().encode(node.content).length;
  const isLargeContent = contentBytes > LARGE_CONTENT_BYTES;
  if (view === "edit") {
    return (
      <EditDocument
        canisterId={canisterId}
        databaseId={databaseId}
        node={node}
        isLargeContent={isLargeContent}
        contentBytes={contentBytes}
        tab={tab}
        authReady={authReady}
        onLogin={onLogin}
        writeIdentity={writeIdentity}
        currentDatabaseRole={currentDatabaseRole}
        databaseRoleError={databaseRoleError}
        databaseCyclesError={databaseCyclesError}
        onNodeSaved={onNodeSaved}
        onEditStateChange={onEditStateChange}
      />
    );
  }
  return (
    <article className="h-full overflow-auto px-6 py-6 md:px-10">
      {view === "raw" ? (
        <RawContent key={`${node.path}-${node.etag}`} content={node.content} isLargeContent={isLargeContent} contentBytes={contentBytes} />
      ) : isLargeContent ? (
        <LargeMarkdownPreview key={`${node.path}:${node.etag}`} content={node.content} contentBytes={contentBytes} canisterId={canisterId} databaseId={databaseId} nodePath={node.path} />
      ) : (
        <div className="markdown-body mx-auto max-w-3xl">
          <MarkdownPreview canisterId={canisterId} databaseId={databaseId} nodePath={node.path} content={node.content} />
        </div>
      )}
    </article>
  );
}

function EditDocument({
  canisterId,
  databaseId,
  node,
  isLargeContent,
  contentBytes,
  tab,
  authReady,
  onLogin,
  writeIdentity,
  currentDatabaseRole,
  databaseRoleError,
  databaseCyclesError,
  onNodeSaved,
  onEditStateChange
}: {
  canisterId: string;
  databaseId: string;
  node: WikiNode;
  isLargeContent: boolean;
  contentBytes: number;
  tab?: ModeTab;
  authReady: boolean;
  onLogin?: () => void;
  writeIdentity: Identity | null;
  currentDatabaseRole: DatabaseRole | null;
  databaseRoleError: string | null;
  databaseCyclesError: string | null;
  onNodeSaved?: () => Promise<WikiNode>;
  onEditStateChange?: (state: DocumentEditState) => void;
}) {
  const editable = node.kind === "file" && node.path.endsWith(".md") && !isKnowledgeSourcePath(node.path);
  if (!editable) {
    return <EditorUnavailable title="Read-only node" message="Only existing Markdown file nodes outside source evidence can be edited in the browser." />;
  }
  if (!writeIdentity) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <section className="max-w-xl rounded-2xl border border-line bg-paper p-6 shadow-sm">
          <p className="font-mono text-xs uppercase tracking-[0.18em] text-muted">Edit access</p>
          <h3 className="mt-3 text-2xl font-semibold tracking-[-0.04em] text-ink">Login required</h3>
          <p className="mt-3 text-sm leading-6 text-muted">Login with Internet Identity to save Markdown changes.</p>
          {onLogin ? (
            <button
              className="mt-5 rounded-2xl border border-action bg-action px-4 py-2 text-sm font-bold text-white hover:-translate-y-[3px] hover:border-accent hover:bg-accent disabled:cursor-not-allowed disabled:translate-y-0 disabled:opacity-60"
              disabled={!authReady}
              type="button"
              onClick={onLogin}
            >
              Login with Internet Identity
            </button>
          ) : null}
        </section>
      </div>
    );
  }
  if (databaseRoleError) {
    return <EditorUnavailable title="Database role unavailable" message={databaseRoleError} />;
  }
  if (!currentDatabaseRole) {
    return <EditorUnavailable title="Database role unavailable" message="Reload database membership before editing this Markdown node." />;
  }
  if (currentDatabaseRole !== "writer" && currentDatabaseRole !== "owner") {
    return <EditorUnavailable title="Writer or owner access required" message="This principal can read the database but cannot save Markdown changes." />;
  }
  if (databaseCyclesError) {
    return <EditorUnavailable title="Database cycles required" message={databaseCyclesError} />;
  }
  if (!onNodeSaved) {
    return <EditorUnavailable title="Save unavailable" message="The browser cannot refresh this node after saving." />;
  }
  return (
    <MarkdownEditDocument
      canisterId={canisterId}
      databaseId={databaseId}
      node={node}
      isLargeContent={isLargeContent}
      contentBytes={contentBytes}
      writeIdentity={writeIdentity}
      onNodeSaved={onNodeSaved}
      onEditStateChange={onEditStateChange}
    />
  );
}

function LargeMarkdownPreview({
  content,
  contentBytes,
  canisterId,
  databaseId,
  nodePath
}: {
  content: string;
  contentBytes: number;
  canisterId: string;
  databaseId: string;
  nodePath: string;
}) {
  const sections = splitMarkdownPreviewSections(content);
  const [visibleSections, setVisibleSections] = useState(1);
  if (sections.length < 2) {
    return <LargeContentState contentBytes={contentBytes} canisterId={canisterId} databaseId={databaseId} nodePath={nodePath} reason="No section headings found." />;
  }
  const cappedVisibleSections = Math.min(visibleSections, sections.length);
  const showingFullPreview = cappedVisibleSections >= sections.length;
  const previewContent = sections.slice(0, cappedVisibleSections).join("\n");
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-yellow-200 bg-yellow-50 p-3 text-sm text-yellow-900">
        <p>
          Large file: showing {cappedVisibleSections.toLocaleString()} of {sections.length.toLocaleString()} sections. Size: {contentBytes.toLocaleString()} bytes.
        </p>
        {showingFullPreview ? <p className="mt-2 font-medium">Showing full preview.</p> : null}
      </div>
      <div className="markdown-body mx-auto max-w-3xl">
        <MarkdownPreview canisterId={canisterId} databaseId={databaseId} nodePath={nodePath} content={previewContent} />
      </div>
      {!showingFullPreview ? (
        <button
          className="rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink hover:border-accent"
          type="button"
          onClick={() => setVisibleSections((current) => Math.min(current + 1, sections.length))}
        >
          Load next section
        </button>
      ) : null}
    </div>
  );
}

function RawContent({
  content,
  isLargeContent,
  contentBytes
}: {
  content: string;
  isLargeContent: boolean;
  contentBytes: number;
}) {
  const [visibleChars, setVisibleChars] = useState(isLargeContent ? RAW_INITIAL_CHARS : content.length);
  const cappedVisibleChars = Math.min(visibleChars, content.length);
  const visibleContent = isLargeContent ? content.slice(0, cappedVisibleChars) : content;
  const showingFullFile = cappedVisibleChars >= content.length;
  return (
    <div className="space-y-3">
      {isLargeContent ? (
        <div className="rounded-xl border border-yellow-200 bg-yellow-50 p-3 text-sm text-yellow-900">
          <p>
            Large file: showing {cappedVisibleChars.toLocaleString()} of {content.length.toLocaleString()} characters. Size: {contentBytes.toLocaleString()} bytes.
          </p>
          {showingFullFile ? <p className="mt-2 font-medium">Showing full file.</p> : null}
        </div>
      ) : null}
      <pre className="whitespace-pre-wrap rounded-xl border border-line bg-[#f7f3ea] p-5 font-mono text-sm leading-6">
        {visibleContent}
      </pre>
      {isLargeContent && !showingFullFile ? (
        <button
          className="rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink hover:border-accent"
          type="button"
          onClick={() => setVisibleChars((current) => Math.min(current + RAW_LOAD_STEP_CHARS, content.length))}
        >
          Load more
        </button>
      ) : null}
    </div>
  );
}

function LargeContentState({
  contentBytes,
  canisterId,
  databaseId,
  nodePath,
  reason
}: {
  contentBytes: number;
  canisterId: string;
  databaseId: string;
  nodePath: string;
  reason?: string;
}) {
  return (
    <div className="mx-auto max-w-2xl rounded-2xl border border-line bg-paper p-6 text-sm">
      <p className="font-mono text-xs uppercase tracking-[0.18em] text-muted">Large file</p>
      <h3 className="mt-3 text-2xl font-semibold tracking-[-0.04em]">Preview disabled</h3>
      <p className="mt-3 text-muted">
        This node is {contentBytes.toLocaleString()} bytes. Markdown preview is disabled to keep the browser responsive.
      </p>
      {reason ? <p className="mt-3 text-muted">{reason}</p> : null}
      <Link
        className="mt-5 inline-flex rounded-2xl bg-action px-3 py-2 font-bold text-white no-underline hover:bg-accent"
        href={hrefForPath(canisterId, databaseId, nodePath, "raw")}
      >
        Open raw view
      </Link>
    </div>
  );
}

function FolderDocument({
  folder,
  folderIndexNode,
  childrenState,
  view,
  canisterId,
  databaseId,
  tab,
  authReady,
  onLogin,
  writeIdentity,
  currentDatabaseRole,
  databaseRoleError,
  databaseCyclesError,
  onFolderIndexSaved,
  onEditStateChange
}: {
  folder: WikiNode;
  folderIndexNode: PathLoadState<WikiNode>;
  childrenState: LoadState<ChildNode[]>;
  view: ViewMode;
  canisterId: string;
  databaseId: string;
  tab?: ModeTab;
  authReady: boolean;
  onLogin?: () => void;
  writeIdentity: Identity | null;
  currentDatabaseRole: DatabaseRole | null;
  databaseRoleError: string | null;
  databaseCyclesError: string | null;
  onFolderIndexSaved?: () => Promise<WikiNode>;
  onEditStateChange?: (state: DocumentEditState) => void;
}) {
  const indexNode = folderIndexNode.data ?? emptyFolderIndexNode(folder.path);
  const contentBytes = new TextEncoder().encode(indexNode.content).length;
  const isLargeContent = contentBytes > LARGE_CONTENT_BYTES;
  if (view === "edit") {
    return (
      <EditDocument
        canisterId={canisterId}
        databaseId={databaseId}
        node={indexNode}
        isLargeContent={isLargeContent}
        contentBytes={contentBytes}
        tab={tab}
        authReady={authReady}
        onLogin={onLogin}
        writeIdentity={writeIdentity}
        currentDatabaseRole={currentDatabaseRole}
        databaseRoleError={databaseRoleError}
        databaseCyclesError={databaseCyclesError}
        onNodeSaved={onFolderIndexSaved}
        onEditStateChange={onEditStateChange}
      />
    );
  }
  return (
    <div className="h-full overflow-auto p-6">
      <div className="space-y-6">
        <FolderIndexSection
          folderPath={folder.path}
          folderIndexNode={folderIndexNode}
          view={view}
          isLargeContent={isLargeContent}
          contentBytes={contentBytes}
          canisterId={canisterId}
          databaseId={databaseId}
        />
        <DirectoryChildrenCard childrenState={childrenState} canisterId={canisterId} databaseId={databaseId} parentPath={folder.path} />
      </div>
    </div>
  );
}

function FolderIndexSection({
  folderPath,
  folderIndexNode,
  view,
  isLargeContent,
  contentBytes,
  canisterId,
  databaseId
}: {
  folderPath: string;
  folderIndexNode: PathLoadState<WikiNode>;
  view: "preview" | "raw";
  isLargeContent: boolean;
  contentBytes: number;
  canisterId: string;
  databaseId: string;
}) {
  if (folderIndexNode.loading) {
    return <p className="text-sm text-muted">Loading folder note...</p>;
  }
  if (folderIndexNode.error) {
    return <ErrorBox message={folderIndexNode.error} hint={folderIndexNode.hint} />;
  }
  if (!folderIndexNode.data) {
    return null;
  }
  const indexNode = folderIndexNode.data;
  return (
    <section className="rounded-2xl border border-line bg-paper p-5">
      <p className="font-mono text-xs uppercase tracking-[0.18em] text-muted">Folder note</p>
      <div className="mt-4">
        {view === "raw" ? (
          <RawContent content={indexNode.content} isLargeContent={isLargeContent} contentBytes={contentBytes} />
        ) : isLargeContent ? (
          <LargeMarkdownPreview key={`${indexNode.path}:${indexNode.etag}`} content={indexNode.content} contentBytes={contentBytes} canisterId={canisterId} databaseId={databaseId} nodePath={folderPath} />
        ) : (
          <div className="markdown-body mx-auto max-w-3xl">
            <MarkdownPreview canisterId={canisterId} databaseId={databaseId} nodePath={folderPath} content={indexNode.content} />
          </div>
        )}
      </div>
    </section>
  );
}

function DirectoryDocument({
  childrenState,
  canisterId,
  databaseId,
  parentPath
}: {
  childrenState: LoadState<ChildNode[]>;
  canisterId: string;
  databaseId: string;
  parentPath: string;
}) {
  return (
    <div className="h-full overflow-auto p-6">
      <DirectoryChildrenCard childrenState={childrenState} canisterId={canisterId} databaseId={databaseId} parentPath={parentPath} />
    </div>
  );
}

function DirectoryChildrenCard({
  childrenState,
  canisterId,
  databaseId,
  parentPath
}: {
  childrenState: LoadState<ChildNode[]>;
  canisterId: string;
  databaseId: string;
  parentPath: string;
}) {
  const children = childrenState.data ? visibleChildren(childrenState.data, parentPath) : null;
  return (
    <div className="rounded-2xl border border-line bg-paper p-5">
      <p className="font-mono text-xs uppercase tracking-[0.18em] text-muted">Directory</p>
      <h3 className="mt-2 text-2xl font-semibold tracking-[-0.04em]">Children</h3>
      <div className="mt-5 grid gap-2">
        {childrenState.loading ? <p className="text-sm text-muted">Loading children...</p> : null}
        {!childrenState.loading && children?.length === 0 ? <p className="text-sm text-muted">No children.</p> : null}
        {children?.map((child) => (
          <Link
            key={child.path}
            href={hrefForPath(canisterId, databaseId, child.path)}
            className="flex items-center justify-between rounded-xl border border-line bg-white px-4 py-3 text-sm no-underline hover:border-accent"
          >
            <span className="flex min-w-0 items-center gap-2">
              {child.kind === "directory" || child.kind === "folder" ? <Folder size={16} /> : <FileText size={16} />}
              <span className="truncate">{child.name}</span>
            </span>
            <span className="font-mono text-xs text-muted">{child.kind}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}

function emptyFolderIndexNode(folderPath: string): WikiNode {
  const path = folderIndexPath(folderPath);
  return {
    path,
    kind: "file",
    content: "",
    createdAt: "",
    updatedAt: "",
    etag: "",
    metadataJson: "{}"
  };
}

function HeaderBadge({ label, tone }: { label: string; tone: "blue" | "green" | "yellow" }) {
  const className =
    tone === "green"
      ? "bg-emerald-100 text-emerald-900"
      : tone === "yellow"
        ? "bg-yellow-100 text-yellow-900"
        : "bg-accentSoft text-accentText";
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${className}`}>{label}</span>;
}

function ViewButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className={`rounded-xl px-2 py-1.5 sm:px-3 ${active ? "bg-accent text-white" : "text-muted hover:bg-accentSoft hover:text-accentText"}`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function EditorUnavailable({ title, message, actionHref, actionLabel }: { title: string; message: string; actionHref?: string; actionLabel?: string }) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <section className="max-w-xl rounded-2xl border border-line bg-paper p-6 shadow-sm">
        <p className="font-mono text-xs uppercase tracking-[0.18em] text-muted">Edit unavailable</p>
        <h3 className="mt-3 text-2xl font-semibold tracking-[-0.04em] text-ink">{title}</h3>
        <p className="mt-3 text-sm leading-6 text-muted">{message}</p>
        {actionHref && actionLabel ? (
          <Link className="mt-5 inline-flex rounded-2xl border border-action bg-action px-4 py-2 text-sm font-bold text-white no-underline hover:-translate-y-[3px] hover:border-accent hover:bg-accent" href={actionHref}>
            {actionLabel}
          </Link>
        ) : null}
      </section>
    </div>
  );
}

function LoadingBlock() {
  return (
    <div className="flex h-full items-center justify-center text-muted">
      <Loader2 size={20} className="mr-2 animate-spin" />
      Loading knowledge node
    </div>
  );
}

function isVfsNotFound(nodeError: string | null, childrenError: string | null): boolean {
  return Boolean(nodeError?.includes("node not found:") && childrenError?.includes("path not found:"));
}
