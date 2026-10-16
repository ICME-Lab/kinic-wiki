"use client";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useReducer,
  useState,
  type ReactNode,
} from "react";
import type { Identity } from "@icp-sdk/core/agent";
import { WorkflowReader, workflowRoles } from "@/lib/workflow-presentation";
import { WikiNavigationLink } from "@/components/wiki-navigation";
import { nodeRequestKey } from "@/lib/request-keys";
import { hrefForPath } from "@/lib/paths";
const Context = createContext<{
  reader: WorkflowReader;
  raw: boolean;
  toggle: () => void;
  refresh: () => void;
  reload: () => void;
  generation: number;
} | null>(null);
export function WorkflowPresentationProvider({
  canisterId,
  databaseId,
  identity,
  metadataChange,
  children,
}: {
  canisterId: string;
  databaseId: string;
  identity: Identity | null;
  metadataChange?: { path: string; requestKey: string };
  children: ReactNode;
}) {
  const principal = identity?.getPrincipal().toText() ?? "anonymous";
  return (
    <ScopedProvider
      key={`${canisterId}:${databaseId}:${principal}`}
      canisterId={canisterId}
      databaseId={databaseId}
      identity={identity}
      metadataChange={metadataChange}
    >
      {children}
    </ScopedProvider>
  );
}
function ScopedProvider({
  canisterId,
  databaseId,
  identity,
  metadataChange,
  children,
}: {
  canisterId: string;
  databaseId: string;
  identity: Identity | null;
  metadataChange?: { path: string; requestKey: string };
  children: ReactNode;
}) {
  const [raw, setRaw] = useState(false);
  const [generation, advance] = useReducer((x: number) => x + 1, 0);
  const [, refresh] = useReducer((x: number) => x + 1, 0);
  const identityRef = useRef(identity);
  useEffect(() => {
    identityRef.current = identity;
  }, [identity]);
  // ScopedProvider is keyed by connection and principal. Navigation never replaces this reader.
  const [reader] = useState(
    () =>
      new WorkflowReader(async (path) => {
        const { readNode } = await import("@/lib/vfs-client");
        return (
          (
            await readNode(
              canisterId,
              databaseId,
              path,
              identityRef.current ?? undefined,
            )
          )?.content ?? null
        );
      }),
  );
  useEffect(() => {
    if (
      !metadataChange ||
      metadataChange.requestKey !==
        nodeRequestKey(
          canisterId,
          databaseId,
          metadataChange.path,
          identity?.getPrincipal().toText() ?? null,
        )
    )
      return;
    reader.invalidate(metadataChange.path);
    advance();
  }, [reader, metadataChange, canisterId, databaseId, identity]);
  const reload = () => {
    reader.invalidate();
    advance();
  };
  return (
    <Context.Provider
      value={{
        reader,
        raw,
        toggle: () => setRaw((x) => !x),
        refresh,
        reload,
        generation,
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function useWorkflowPresentation(paths: string[] = []) {
  const context = useContext(Context);
  const reader = context?.reader,
    refresh = context?.refresh;
  const generation = context?.generation;
  const key = JSON.stringify(paths);
  useEffect(() => {
    if (!reader) return;
    let cancelled = false;
    Promise.all(
      (JSON.parse(key) as string[]).map((path) => reader.load(path)),
    ).then(() => {
      if (!cancelled) refresh?.();
    });
    return () => {
      cancelled = true;
    };
  }, [reader, refresh, key, generation]);
  return {
    label: (path: string, fallback: string) =>
      context?.raw ? fallback : (reader?.label(path) ?? fallback),
    management: (path: string) => !context?.raw && !!reader?.isManagement(path),
    workflow: (path: string) =>
      context?.raw ? undefined : reader?.workflows.get(path),
    raw: context?.raw ?? true,
    toggle: context?.toggle,
    reload: context?.reload,
  };
}
export function WorkflowDisplayToggle() {
  const view = useWorkflowPresentation();
  if (!view.toggle) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex items-center gap-2 px-2 py-1 text-xs">
        <input type="checkbox" checked={view.raw} onChange={view.toggle} />
        実ファイル名で表示
      </label>
      <button
        type="button"
        className="rounded border border-line px-2 py-1 text-xs"
        onClick={view.reload}
      >
        表示を更新
      </button>
    </div>
  );
}
export function ManagementGroup({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="min-w-0 rounded-lg border border-line p-2 text-sm"
    >
      <summary className="cursor-pointer">管理情報</summary>
      {open ? <div className="mt-2 space-y-2">{children}</div> : null}
    </details>
  );
}
export function WorkflowSummary({
  path,
  canisterId,
  databaseId,
  existingPaths = [],
  compact = false,
}: {
  compact?: boolean;
  path: string;
  canisterId: string;
  databaseId: string;
  existingPaths?: string[];
}) {
  const view = useWorkflowPresentation([path]);
  const workflow = view.workflow(path);
  if (!workflow) return null;
  if (compact)
    return (
      <ul className="space-y-1 pl-6 text-sm">
        {Object.entries(workflow.artifacts)
          .filter(([, a]) => !existingPaths.includes(a.path))
          .map(([role, a]) => (
            <li key={role}>
              <WikiNavigationLink
                href={hrefForPath(canisterId, databaseId, a.path)}
              >
                {workflowRoles[role]}
              </WikiNavigationLink>
            </li>
          ))}
      </ul>
    );
  return (
    <section
      className="min-w-0 space-y-3 rounded-xl border border-line p-4"
      aria-label="案件情報"
    >
      <h3 className="break-words text-lg font-semibold">{workflow.title}</h3>
      <p className="text-sm">
        登録状態: {workflow.state === "ready" ? "登録済み" : "初期化中"}
      </p>
      {workflow.current_state ? (
        <p className="whitespace-pre-wrap break-words text-sm">
          {workflow.current_state}
        </p>
      ) : null}
      <ul className="space-y-2">
        {Object.entries(workflow.artifacts)
          .filter(([, a]) => !existingPaths.includes(a.path))
          .map(([role, a]) => (
            <li key={role}>
              <WikiNavigationLink
                href={hrefForPath(canisterId, databaseId, a.path)}
              >
                {workflowRoles[role] ?? role}
              </WikiNavigationLink>
            </li>
          ))}
      </ul>
    </section>
  );
}
