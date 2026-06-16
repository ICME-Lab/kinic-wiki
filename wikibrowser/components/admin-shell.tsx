"use client";

// Where: shared wikibrowser management routes.
// What: renders the common navigation sidebar for admin-style pages.
// Why: marketplace filters belong to marketplace content; cross-page navigation belongs to one shell.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode } from "react";
import { BookOpen, LayoutDashboard, PanelLeft, PowerOff, Store, UserRound, Wallet } from "lucide-react";
import { useAppSession } from "@/app/app-session-provider";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";

const ADMIN_NAV_ITEMS = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/marketplace", label: "Marketplace", icon: Store },
  { href: "/cycles", label: "Cycles", icon: Wallet },
  { href: "/profile", label: "My Profile", icon: UserRound },
  { href: "/cli", label: "CLI Guide", icon: BookOpen }
] as const;

export function AdminShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (!isAdminShellPath(pathname)) return <>{children}</>;

  const sidebar = <AdminSidebar pathname={pathname} />;
  return (
    <section className="grid flex-1 grid-cols-1 bg-canvas text-ink lg:grid-cols-[240px_minmax(0,1fr)]">
      <aside className="hidden border-r border-line bg-paper lg:block">{sidebar}</aside>
      <div className="min-w-0">
        <div className="flex items-center gap-2 px-4 pt-4 lg:hidden">
          <Sheet>
            <SheetTrigger asChild>
              <button className="grid h-10 w-10 place-items-center rounded-lg border border-line bg-white text-ink shadow-sm hover:border-accent hover:text-accent" type="button" aria-label="Open admin navigation">
                <PanelLeft aria-hidden size={18} />
              </button>
            </SheetTrigger>
            <SheetContent side="left" className="w-[280px] max-w-[85vw] bg-paper p-0">
              <SheetHeader className="sr-only">
                <SheetTitle>Admin navigation</SheetTitle>
                <SheetDescription>Navigate Kinic Wiki management pages.</SheetDescription>
              </SheetHeader>
              {sidebar}
            </SheetContent>
          </Sheet>
        </div>
        {children}
      </div>
    </section>
  );
}

export function AdminContent({ children }: { children: ReactNode }) {
  return (
    <main className="min-h-0 px-4 pb-8 pt-4 sm:px-6">
      <section className="mx-auto flex max-w-6xl flex-col gap-6">{children}</section>
    </main>
  );
}

function AdminSidebar({ pathname }: { pathname: string }) {
  return (
    <div className="flex min-h-0 flex-col gap-4 p-3">
      <nav className="flex flex-col gap-2" aria-label="Admin navigation">
        {ADMIN_NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const active = isActiveAdminPath(pathname, item.href);
          return (
            <Link
              aria-current={active ? "page" : undefined}
              className={`flex min-h-10 items-center gap-3 rounded-lg px-3 text-sm font-semibold no-underline transition-colors ${
                active ? "bg-accent text-white" : "text-muted hover:bg-accentSoft hover:text-accentText"
              }`}
              href={item.href}
              key={item.href}
            >
              <Icon aria-hidden size={17} />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>
      <AdminAccountControls />
    </div>
  );
}

function AdminAccountControls() {
  const { authLoading, authReady, login, logout, principal } = useAppSession();

  return (
    <section className="grid gap-2 border-t border-line pt-4" aria-label="Account">
      <div className="px-3 text-xs font-semibold uppercase text-muted">Account</div>
      {!principal ? (
        <button
          className="mx-3 min-h-10 rounded-lg border border-action bg-action px-3 text-sm font-bold text-white hover:border-accent hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
          disabled={!authReady}
          data-tid="login-button"
          type="button"
          onClick={() => void login()}
        >
          Internet Identity
        </button>
      ) : (
        <div className="mx-3 flex min-h-10 items-center gap-2 rounded-lg border border-line bg-white px-3 py-2 text-sm">
          <span className="min-w-0 flex-1 truncate text-muted">{shortPrincipal(principal)}</span>
          <button
            aria-label="Log out"
            className="grid size-8 shrink-0 place-items-center rounded-lg text-muted hover:bg-paper hover:text-accent disabled:cursor-not-allowed disabled:opacity-60"
            disabled={authLoading}
            title="Log out"
            type="button"
            onClick={() => void logout()}
          >
            <PowerOff aria-hidden size={16} />
          </button>
        </div>
      )}
    </section>
  );
}

function isAdminShellPath(pathname: string): boolean {
  return pathname === "/dashboard" || pathname.startsWith("/dashboard/") || pathname === "/metrics" || pathname === "/marketplace" || pathname.startsWith("/marketplace/") || pathname === "/cycles" || pathname === "/profile" || pathname === "/cli";
}

function isActiveAdminPath(pathname: string, href: string): boolean {
  if (href === "/dashboard") return pathname === "/dashboard" || pathname.startsWith("/dashboard/");
  if (href === "/metrics") return pathname === "/metrics";
  if (href === "/marketplace") return pathname === "/marketplace" || pathname.startsWith("/marketplace/");
  return pathname === href;
}

function shortPrincipal(value: string): string {
  if (value.length <= 16) return value;
  return `${value.slice(0, 8)}...${value.slice(-5)}`;
}
