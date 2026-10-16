// @vitest-environment jsdom
import type { AnchorHTMLAttributes } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import {
  WorkflowPresentationProvider,
  WorkflowSummary,
  WorkflowDisplayToggle,
  useWorkflowPresentation,
} from "./workflow-presentation";
import { nodeRequestKey } from "@/lib/request-keys";
import { DocumentPane, DocumentHeader } from "./document-pane";
import { SearchPanel } from "./search-panel";
import type { ChildNode, WikiNode } from "@/lib/types";
const api = vi.hoisted(() => ({ readNode: vi.fn(), searchNodes: vi.fn() }));
vi.mock("@/lib/vfs-client", () => api);
vi.mock("@/components/wiki-navigation", () => ({
  WikiNavigationLink: ({
    href,
    children,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
  useWikiNavigation: () => ({ navigate: vi.fn() }),
}));
const root = "/Knowledge/demo",
  id = "a222c796-4cff-4fa7-9887-c7732c523a1a",
  path = root + "/workflows/" + id;
const manifest = {
  version: 2,
  id,
  nonce: id,
  title: "同期チェック",
  state: "ready",
  current_state: "実装中",
  project_fingerprint: "x",
  artifacts: { plan: { path: root + "/plans/a.md", local: "docs/a.md" } },
};
const node = (
  path: string,
  content = "",
  kind: WikiNode["kind"] = "file",
): WikiNode => ({
  path,
  content,
  kind,
  etag: "v1",
  metadataJson: "{}",
  createdAt: "0",
  updatedAt: "0",
});
const state = <T,>(data: T) => ({ data, path, loading: false, error: null });
const child = (name: string): ChildNode => ({
  path: path + "/" + name,
  name,
  kind: "file",
  etag: null,
  updatedAt: null,
  sizeBytes: null,
  isVirtual: false,
  hasChildren: false,
  isPublished: false,
});
function setup() {
  api.readNode.mockImplementation(async (_c, _d, p) =>
    node(
      p,
      JSON.stringify(
        p.endsWith("project.json")
          ? { version: 1, id, nonce: id, name: "demo", repository_key: "repo" }
          : manifest,
      ),
    ),
  );
}
const wrap = (children: React.ReactNode, db = "db") => (
  <WorkflowPresentationProvider canisterId="c" databaseId={db} identity={null}>
    {children}
  </WorkflowPresentationProvider>
);
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
it("shows canonical document links, status and closed management group; raw toggle restores files", async () => {
  setup();
  const screen = render(
    wrap(
      <>
        <WorkflowDisplayToggle />
        <DocumentPane
          canisterId="c"
          databaseId="db"
          view="preview"
          node={state(node(path, "", "folder"))}
          childrenState={state([child("manifest.json"), child("other.md")])}
          folderOverviewNode={{ ...state<WikiNode | null>(null) }}
        />
      </>,
    ),
  );
  await screen.findByText("同期チェック");
  expect(screen.getByText("実装中")).toBeTruthy();
  expect(screen.queryByText("作業完了")).toBeNull();
  expect(screen.getByText("計画").getAttribute("href")).toContain(
    "/Knowledge/demo/plans/a.md",
  );
  expect(screen.getByText("管理情報").parentElement?.hasAttribute("open")).toBe(
    false,
  );
  expect(screen.getByText("other.md")).toBeTruthy();
  fireEvent.click(screen.getByLabelText("実ファイル名で表示"));
  expect(screen.queryByText("管理情報")).toBeNull();
  expect(screen.getByText("manifest.json")).toBeTruthy();
});
it("does not duplicate a registered document in the same directory", async () => {
  setup();
  api.readNode.mockImplementation(async (_c, _d, p) =>
    node(
      p,
      JSON.stringify(
        p.endsWith("project.json")
          ? { version: 1, id, nonce: id, name: "demo", repository_key: "repo" }
          : {
              ...manifest,
              artifacts: { plan: { path: path + "/plan.md", local: "p.md" } },
            },
      ),
    ),
  );
  const screen = render(
    wrap(
      <DocumentPane
        canisterId="c"
        databaseId="db"
        view="preview"
        node={state(node(path, "", "folder"))}
        childrenState={state([child("manifest.json"), child("plan.md")])}
        folderOverviewNode={state<WikiNode | null>(null)}
      />,
    ),
  );
  await screen.findByText("同期チェック");
  expect(screen.getAllByText("計画")).toHaveLength(1);
});
it("ignores a late response from the previous database", async () => {
  let finish: (value: WikiNode) => void = () => {};
  api.readNode.mockImplementation((_c, db, _p) =>
    db === "old"
      ? new Promise<WikiNode>((resolve) => {
          finish = resolve;
        })
      : Promise.resolve(null),
  );
  const screen = render(
    wrap(
      <WorkflowSummary path={path} canisterId="c" databaseId="old" />,
      "old",
    ),
  );
  await waitFor(() => expect(api.readNode).toHaveBeenCalled());
  screen.rerender(
    wrap(
      <WorkflowSummary path={path} canisterId="c" databaseId="new" />,
      "new",
    ),
  );
  finish(
    node(
      root + "/project.json",
      JSON.stringify({
        version: 1,
        id,
        nonce: id,
        name: "demo",
        repository_key: "repo",
      }),
    ),
  );
  await new Promise((r) => setTimeout(r, 10));
  expect(screen.queryByText("同期チェック")).toBeNull();
});
it("labels breadcrumb while preserving canonical href and copying actual path", async () => {
  setup();
  const screen = render(
    wrap(
      <DocumentHeader
        canisterId="c"
        databaseId="db"
        path={path}
        view="preview"
        onViewChange={() => {}}
        isDirectory
        canEditDirectory={false}
        editState={{ dirty: false, saveState: "idle" }}
        rawContent={null}
      />,
    ),
  );
  await screen.findByText("同期チェック · a222c796");
  expect(screen.getByText("案件").getAttribute("href")).toContain("/workflows");
});
it("pretty prints directly opened management JSON", async () => {
  setup();
  const screen = render(
    wrap(
      <DocumentPane
        canisterId="c"
        databaseId="db"
        view="preview"
        node={state(node(path + "/manifest.json", JSON.stringify(manifest)))}
        childrenState={state([])}
        folderOverviewNode={state<WikiNode | null>(null)}
      />,
    ),
  );
  await screen.findByText("管理情報");
  expect(screen.container.querySelector("pre")?.textContent).toContain(
    '\n  "version": 2',
  );
});
it("groups only verified search hits and keeps ordinary JSON visible", async () => {
  setup();
  api.searchNodes.mockResolvedValue([
    { path: path + "/manifest.json", score: 1, preview: "metadata" },
    { path: "/Knowledge/ordinary.json", score: 0.5, preview: "ordinary" },
  ]);
  const screen = render(
    wrap(
      <SearchPanel
        canisterId="c"
        databaseId="db"
        query="demo"
        initialKind="full"
        readIdentity={null}
      />,
    ),
  );
  await screen.findByText("管理情報");
  expect(screen.getByText("/Knowledge/ordinary.json")).toBeTruthy();
});
it("refreshes metadata after explicit refresh and saved-node revision", async () => {
  setup();
  const summary = (
    <>
      <WorkflowDisplayToggle />
      <WorkflowSummary path={path} canisterId="c" databaseId="db" />
    </>
  );
  const screen = render(wrap(summary));
  await screen.findByText("同期チェック");
  api.readNode.mockImplementation(async (_c, _d, p) =>
    node(
      p,
      JSON.stringify(
        p.endsWith("project.json")
          ? { version: 1, id, nonce: id, name: "demo", repository_key: "repo" }
          : { ...manifest, title: "Updated" },
      ),
    ),
  );
  fireEvent.click(screen.getByText("表示を更新"));
  await screen.findByText("Updated");
  expect(screen.queryByText("同期チェック")).toBeNull();
  api.readNode.mockImplementation(async () => null);
  screen.rerender(
    <WorkflowPresentationProvider
      canisterId="c"
      databaseId="db"
      identity={null}
      metadataChange={{
        path: path + "/manifest.json",
        requestKey: nodeRequestKey("c", "db", path + "/manifest.json", null),
      }}
    >
      {summary}
    </WorkflowPresentationProvider>,
  );
  await waitFor(() => expect(screen.queryByText("Updated")).toBeNull());
});
it("does not keep a title when the reader principal changes", async () => {
  setup();
  const summary = (
    <WorkflowSummary path={path} canisterId="c" databaseId="db" />
  );
  const screen = render(wrap(summary));
  await screen.findByText("同期チェック");
  api.readNode.mockRejectedValue(Error("denied"));
  const identity = {
    getPrincipal: () => ({ toText: () => "different-reader" }),
  } as never;
  screen.rerender(
    <WorkflowPresentationProvider
      canisterId="c"
      databaseId="db"
      identity={identity}
    >
      {summary}
    </WorkflowPresentationProvider>,
  );
  expect(screen.queryByText("同期チェック")).toBeNull();
});

it("keeps cached metadata across page navigation and a stable request queue during refresh", async () => {
  setup();
  function Page({ current }: { current: string }) {
    const display = useWorkflowPresentation([current]);
    return <span>{display.label(path, "pending")}</span>;
  }
  const screen = render(wrap(<Page current={path} />));
  await screen.findByText("同期チェック · a222c796");
  const initialCalls = api.readNode.mock.calls.length;
  screen.rerender(wrap(<Page current={path + "/plan.md"} />));
  await waitFor(() =>
    expect(screen.getByText("同期チェック · a222c796")).toBeTruthy(),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(api.readNode).toHaveBeenCalledTimes(initialCalls);
  screen.unmount();

  let active = 0,
    maximum = 0;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  api.readNode.mockImplementation(async (_c, _d, p) => {
    active++;
    maximum = Math.max(maximum, active);
    await gate;
    await new Promise((resolve) => setTimeout(resolve, 3));
    active--;
    return node(
      p,
      JSON.stringify({
        version: 1,
        id,
        nonce: id,
        name: "test",
        repository_key: "repo",
      }),
    );
  });
  function Probes({ count }: { count: number }) {
    useWorkflowPresentation(
      Array.from({ length: count }, (_, i) => "/Knowledge/probe" + i),
    );
    return <WorkflowDisplayToggle />;
  }
  const next = render(wrap(<Probes count={12} />));
  await waitFor(() => expect(active).toBe(4));
  next.rerender(wrap(<Probes count={16} />));
  fireEvent.click(next.getByText("表示を更新"));
  fireEvent.click(next.getByText("表示を更新"));
  release();
  await waitFor(() => expect(active).toBe(0));
  expect(maximum).toBe(4);
});
