// A searchable action list needs rich options, not a native select.
/* eslint-disable jsx-a11y/prefer-tag-over-role */
import * as Dialog from "@radix-ui/react-dialog";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { Command, Search, ArrowUpRight, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { hrefForGraph, hrefForPath, hrefForSearch, parseWikiRoute } from "@/lib/paths";
import { listDatabasesPublic } from "@/lib/vfs-client";
import type { DatabaseSummary } from "@/lib/types";

type PaletteItem = { label: string; detail: string; href: string };
const pages: PaletteItem[] = [
  { label: "Dashboard", detail: "Your databases", href: "/dashboard" },
  { label: "Marketplace", detail: "Discover knowledge", href: "/marketplace" },
  { label: "Cycles", detail: "Top up a database", href: "/cycles" },
  { label: "My Profile", detail: "Account", href: "/profile" },
  { label: "Documentation", detail: "Guides and tools", href: "/docs" },
  { label: "Home", detail: "Kinic Wiki", href: "/" }
];

export function paletteItems(query: string, databaseId: string | null, databases: DatabaseSummary[]): PaletteItem[] {
  const needle = query.trim().toLowerCase();
  const context: PaletteItem[] = databaseId ? [
    { label: "Open knowledge", detail: "Current database", href: hrefForPath("", databaseId, "/Knowledge") },
    { label: "Link graph", detail: "Current database", href: hrefForGraph("", databaseId) },
    { label: "Manage database", detail: databaseId, href: `/dashboard/project/${encodeURIComponent(databaseId)}` }
  ] : [];
  const candidates = [...context, ...pages, ...databases.filter((db) => db.status === "active").map((db) => ({
    label: db.metadata.name, detail: db.databaseId, href: hrefForPath("", db.databaseId, "/Knowledge")
  }))];
  const filtered = candidates.filter((item) => `${item.label} ${item.detail}`.toLowerCase().includes(needle));
  if (databaseId && query.trim()) filtered.unshift({
    label: `Search for “${query.trim()}”`, detail: "Full text · Current database", href: hrefForSearch("", databaseId, query.trim(), "full")
  });
  return filtered;
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [databases, setDatabases] = useState<DatabaseSummary[]>([]);
  const [loadState, setLoadState] = useState("idle");
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const navigate = useNavigate();
  const id = useId();
  const { databaseId } = parseWikiRoute(pathname);
  const items = paletteItems(query, databaseId, databases);
  const active = Math.min(selected, Math.max(0, items.length - 1));
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k" && !event.altKey) {
        event.preventDefault();
        if (!open) returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        setOpen((value) => !value);
        setQuery("");
        setSelected(0);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const canisterId = import.meta.env.VITE_KINIC_WIKI_CANISTER_ID;
    if (!canisterId) return;
    setLoadState("loading");
    void listDatabasesPublic(canisterId).then((rows) => {
      if (!cancelled) { setDatabases(rows); setLoadState("ready"); }
    }).catch(() => { if (!cancelled) setLoadState("error"); });
    return () => { cancelled = true; };
  }, [open]);
  useEffect(() => {
    document.getElementById(`${id}-${active}`)?.scrollIntoView?.({ block: "nearest" });
  }, [active, id]);
  const choose = (item: PaletteItem) => {
    // TanStack navigation still honours WikiNavigationProvider's unsaved-edit blocker.
    returnFocus.current = null;
    void navigate({ to: item.href });
    setOpen(false);
  };
  return (
    <Dialog.Root open={open} onOpenChange={(value) => { setOpen(value); setQuery(""); setSelected(0); }}>
      <Dialog.Trigger asChild>
        <button type="button" aria-label="Open command palette" title="Commands · ⌘K / Ctrl+K" className="fixed bottom-4 right-4 z-40 inline-flex h-9 items-center gap-2 rounded-xl border border-line bg-white/95 px-3 text-xs font-medium text-muted shadow-card backdrop-blur hover:bg-paper hover:text-ink">
          <Command size={14} aria-hidden /><span>Commands</span><kbd className="hidden text-[10px] sm:inline">⌘K / Ctrl K</kbd>
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/20 backdrop-blur-sm" />
        <Dialog.Content onCloseAutoFocus={(event) => {
          const target = returnFocus.current;
          returnFocus.current = null;
          if (target?.isConnected) {
            event.preventDefault();
            target.focus({ preventScroll: true });
          }
        }} className="fixed left-1/2 top-[12vh] z-50 w-[calc(100%-24px)] max-w-xl -translate-x-1/2 overflow-hidden rounded-2xl border border-line bg-white shadow-pop">
          <Dialog.Title className="sr-only">Commands</Dialog.Title>
          <Dialog.Description className="sr-only">Find pages and databases, or search the current database. Use arrow keys and Enter to select.</Dialog.Description>
          <div className="flex items-center gap-3 border-b border-line px-4 py-3">
            <Search size={18} className="shrink-0 text-muted" aria-hidden />
            <input role="combobox" aria-label="Search commands" aria-expanded="true" aria-controls={`${id}-list`} aria-activedescendant={items.length ? `${id}-${active}` : undefined} aria-autocomplete="list" value={query} placeholder="Where would you like to go?" className="h-9 min-w-0 flex-1 bg-transparent text-base text-ink outline-none placeholder:text-muted" onChange={(event) => { setQuery(event.target.value); setSelected(0); }} onKeyDown={(event) => {
              // Safari may report isComposing=false on the IME confirmation Enter, but keyCode remains 229.
              if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                setSelected((active + (event.key === "ArrowDown" ? 1 : -1) + items.length) % (items.length || 1));
              }
              if (event.key === "Enter" && items[active]) { event.preventDefault(); choose(items[active]); }
            }} />
            <Dialog.Close aria-label="Close commands" className="rounded-lg p-2 text-muted hover:bg-paper hover:text-ink"><X size={16} aria-hidden /></Dialog.Close>
          </div>
          <div id={`${id}-list`} role="listbox" aria-label="Commands" className="max-h-[50vh] overflow-y-auto p-2">
            {items.map((item, index) => <button type="button" tabIndex={-1} key={item.href} id={`${id}-${index}`} role="option" aria-selected={index === active} onPointerMove={() => setSelected(index)} onClick={() => choose(item)} className={`flex w-full cursor-pointer items-center text-left justify-between gap-3 rounded-xl px-3 py-2.5 ${index === active ? "bg-paper text-ink" : "text-muted"}`}>
              <div className="min-w-0"><p className="truncate text-sm font-medium text-ink">{item.label}</p><p className="truncate text-xs text-muted">{item.detail}</p></div><ArrowUpRight size={15} aria-hidden />
            </button>)}
            {!items.length ? <p className="px-3 py-6 text-center text-sm text-muted">No matching commands.</p> : null}
          </div>
          <footer className="flex justify-between border-t border-line px-4 py-2.5 text-[11px] text-muted"><span>{loadState === "loading" ? "Loading public databases…" : loadState === "error" ? "Public databases unavailable. Reopen to retry." : "Pages & databases"}</span><span>↑ ↓ select · Enter open · Esc close</span></footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
