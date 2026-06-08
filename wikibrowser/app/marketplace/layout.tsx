"use client";

// Where: marketplace route group.
// What: dedicated navigation shell for marketplace browsing and listing detail pages.
// Why: marketplace needs the premium sidebar, while database browsing keeps its original workspace shell.

import type { ChangeEvent, FormEvent, ReactNode } from "react";
import { Suspense } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ArrowDownAZ, Clock3, LayoutDashboard, PanelLeft, Search, Sparkles, Terminal, TrendingUp } from "lucide-react";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";

const QUICK_FILTERS: { label: string; params: Record<string, string> }[] = [
  {
    label: "All listings",
    params: {}
  },
  {
    label: "Popular",
    params: { sort: "popular" }
  },
  {
    label: "Recent",
    params: { sort: "recent" }
  },
  {
    label: "Low price",
    params: { sort: "price_low" }
  },
  {
    label: "With excerpts",
    params: { preview: "1" }
  }
];

const SORT_ITEMS = [
  {
    value: "recent",
    label: "Recent",
    icon: Clock3
  },
  {
    value: "popular",
    label: "Popular",
    icon: TrendingUp
  },
  {
    value: "price_low",
    label: "Low price",
    icon: ArrowDownAZ
  }
] as const;

const SECONDARY_LINKS = [
  {
    href: "/dashboard",
    label: "Seller dashboard",
    icon: LayoutDashboard
  },
  {
    href: "/cli",
    label: "CLI Guide",
    icon: Terminal
  }
];

export default function MarketplaceLayout({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<MarketplaceShellFallback>{children}</MarketplaceShellFallback>}>
      <MarketplaceShell>{children}</MarketplaceShell>
    </Suspense>
  );
}

function MarketplaceShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const query = searchParams.get("q") ?? "";
  const sort = searchParams.get("sort") ?? "";
  const max = searchParams.get("max") ?? "";
  const previewOnly = searchParams.get("preview") === "1";

  function replaceParams(next: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(next)) {
      if (value === null || value === "") {
        params.delete(key);
      } else {
        params.set(key, value);
      }
    }
    const queryString = params.toString();
    const targetPath = pathname.startsWith("/marketplace/") ? "/marketplace" : pathname;
    router.replace(queryString ? `${targetPath}?${queryString}` : targetPath);
  }

  function runSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const nextQuery = String(formData.get("q") ?? "").trim();
    replaceParams({ q: nextQuery || null });
  }

  function updateMax(event: ChangeEvent<HTMLInputElement>) {
    const normalized = normalizeKinicDecimalInput(event.target.value);
    replaceParams({ max: normalized || null });
  }

  const controls = (
    <MarketplaceBrowseControls
      max={max}
      previewOnly={previewOnly}
      query={query}
      sort={sort}
      onMaxChange={updateMax}
      onReplaceParams={replaceParams}
      onSearch={runSearch}
    />
  );

  return (
    <section className="grid min-h-[calc(100vh-144px)] grid-cols-1 gap-0 bg-canvas text-ink lg:grid-cols-[320px_minmax(0,1fr)]">
      <aside className="hidden border-r border-line bg-paper lg:flex lg:min-h-0 lg:flex-col" data-tid="marketplace-sidebar">
        {controls}
      </aside>
      <main className="min-w-0 bg-canvas">
        <div className="flex min-h-0 flex-col px-3 pb-8 pt-4 sm:px-6">
          <div className="mb-3 flex items-center gap-2 lg:hidden">
            <Sheet>
              <SheetTrigger asChild>
                <button className="grid h-10 w-10 place-items-center rounded-2xl border border-line bg-white text-ink shadow-[0_4px_10px_#14142b0a] hover:border-accent hover:bg-accent hover:text-white" type="button" aria-label="Open marketplace filters">
                  <PanelLeft aria-hidden size={18} />
                </button>
              </SheetTrigger>
              <SheetContent side="left" className="w-[320px] max-w-[85vw] bg-paper p-0">
                <SheetHeader className="sr-only">
                  <SheetTitle>Marketplace filters</SheetTitle>
                  <SheetDescription>Filter and sort loaded marketplace listings.</SheetDescription>
                </SheetHeader>
                <div data-tid="marketplace-sidebar" className="flex h-full min-h-0 flex-col">
                  {controls}
                </div>
              </SheetContent>
            </Sheet>
          </div>
          {children}
        </div>
      </main>
    </section>
  );
}

function MarketplaceShellFallback({ children }: { children: ReactNode }) {
  return (
    <section className="grid min-h-[calc(100vh-144px)] grid-cols-1 gap-0 bg-canvas text-ink lg:grid-cols-[320px_minmax(0,1fr)]">
      <aside className="hidden border-r border-line bg-paper lg:flex lg:min-h-0 lg:flex-col" data-tid="marketplace-sidebar">
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto pt-3">
          <ControlGroup label="Browse marketplace">
            <div className="grid gap-2 px-2">
              <div className="h-10 rounded-xl border border-line bg-white" />
            </div>
          </ControlGroup>
          <ControlGroup label="Quick filters">
            <div className="grid gap-1 px-2">
              <div className="h-9 rounded-xl bg-white" />
              <div className="h-9 rounded-xl bg-white" />
              <div className="h-9 rounded-xl bg-white" />
            </div>
          </ControlGroup>
        </div>
      </aside>
      <main className="min-w-0 bg-canvas">
        <div className="flex min-h-0 flex-col px-3 pb-8 pt-4 sm:px-6">{children}</div>
      </main>
    </section>
  );
}

function MarketplaceBrowseControls({
  max,
  previewOnly,
  query,
  sort,
  onMaxChange,
  onReplaceParams,
  onSearch
}: {
  max: string;
  previewOnly: boolean;
  query: string;
  sort: string;
  onMaxChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onReplaceParams: (next: Record<string, string | null>) => void;
  onSearch: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto pt-3">
        <ControlGroup label="Browse marketplace">
          <form className="grid gap-2 px-2" onSubmit={onSearch}>
            <label className="sr-only" htmlFor="market-search">Search marketplace</label>
            <div className="flex min-h-10 items-center gap-2 rounded-xl border border-line bg-white px-3 focus-within:border-accent">
              <Search aria-hidden className="shrink-0 text-muted" size={16} />
              <input
                id="market-search"
                className="min-w-0 flex-1 bg-transparent py-2 text-sm outline-none"
                name="q"
                placeholder="Filter loaded listings"
                defaultValue={query}
              />
            </div>
          </form>
        </ControlGroup>

        <ControlGroup label="Quick filters">
          <div className="grid gap-1 px-2">
            {QUICK_FILTERS.map((filter) => {
              const active = isQuickFilterActive(filter.params, { sort, previewOnly, query, max });
              return (
                <button
                  className={`flex min-h-9 items-center justify-between rounded-xl px-3 text-left text-sm font-semibold transition-colors ${active ? "bg-accent text-white" : "text-muted hover:bg-accentSoft hover:text-accentText"}`}
                  key={filter.label}
                  type="button"
                  onClick={() => {
                    if (filter.label === "All listings") {
                      onReplaceParams({ q: null, sort: null, max: null, preview: null });
                    } else {
                      onReplaceParams(filter.params);
                    }
                  }}
                >
                  <span>{filter.label}</span>
                  {active ? <Sparkles aria-hidden size={14} /> : null}
                </button>
              );
            })}
          </div>
        </ControlGroup>

        <ControlGroup label="Sort loaded listings">
          <div className="grid gap-1 px-2">
            {SORT_ITEMS.map((item) => {
              const Icon = item.icon;
              const active = sort === item.value;
              return (
                <button
                  className={`flex min-h-9 items-center gap-2 rounded-xl px-3 text-sm font-semibold transition-colors ${active ? "bg-accent text-white" : "text-muted hover:bg-accentSoft hover:text-accentText"}`}
                  key={item.value}
                  type="button"
                  onClick={() => onReplaceParams({ sort: active ? null : item.value })}
                >
                  <Icon aria-hidden size={16} />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </div>
        </ControlGroup>

        <ControlGroup label="Price">
          <div className="grid gap-2 px-2">
            <label className="text-xs font-semibold text-muted" htmlFor="market-max-price">Max price</label>
            <Input
              id="market-max-price"
              className="h-10 rounded-xl bg-white font-mono text-xs"
              inputMode="decimal"
              placeholder="0.5 KINIC"
              value={max}
              onChange={onMaxChange}
            />
          </div>
        </ControlGroup>
      </div>
      <footer className="border-t border-line bg-white/80 p-3">
        <div className="grid gap-1">
          {SECONDARY_LINKS.map((item) => {
            const Icon = item.icon;
            return (
              <MarketSidebarLink className="flex min-h-9 items-center gap-2 rounded-xl px-3 text-sm font-semibold text-muted hover:bg-accentSoft hover:text-accentText" href={item.href} key={item.href}>
                <Icon aria-hidden size={16} />
                <span>{item.label}</span>
              </MarketSidebarLink>
            );
          })}
        </div>
        <Separator className="my-2 bg-line" />
        <p className="px-2 font-mono text-[10px] uppercase text-muted">Filter loaded listings</p>
      </footer>
    </>
  );
}

function ControlGroup({ children, label }: { children: ReactNode; label: string }) {
  return (
    <section className="grid gap-2">
      <h2 className="px-4 text-xs font-medium text-muted">{label}</h2>
      {children}
    </section>
  );
}

function isQuickFilterActive(
  params: Record<string, string>,
  current: { sort: string; previewOnly: boolean; query: string; max: string }
): boolean {
  if (Object.keys(params).length === 0) {
    return !current.sort && !current.previewOnly && !current.query && !current.max;
  }
  if (params.sort) return current.sort === params.sort;
  if (params.preview) return current.previewOnly;
  return false;
}

function MarketSidebarLink({
  children,
  href,
  className,
  ...props
}: {
  children: ReactNode;
  href: string;
  className?: string;
  "aria-current"?: "page";
  "aria-label"?: string;
}) {
  return (
    <Link
      href={href}
      className={className}
      {...props}
    >
      {children}
    </Link>
  );
}

function normalizeKinicDecimalInput(value: string): string | null {
  const normalized = value.replace(/[^\d.]/g, "");
  const [whole = "", ...fractions] = normalized.split(".");
  const fraction = fractions.join("").slice(0, 8);
  if (!whole && !fraction) return null;
  return fraction ? `${whole || "0"}.${fraction}` : whole;
}
