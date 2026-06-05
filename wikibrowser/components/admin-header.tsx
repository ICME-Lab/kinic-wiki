// Where: shared admin pages in wikibrowser.
// What: renders the common Kinic Wiki admin header shell.
// Why: dashboard, database management, and Skill Registry should present one management UI shape.
import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";

export function AdminHeader({ actions, nav, title, titleAction }: { actions?: ReactNode; nav?: ReactNode; title: string; titleAction?: ReactNode }) {
  return (
    <header className="flex flex-col gap-4 border-b border-line pb-5 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {nav ? <nav className="flex flex-wrap items-center gap-2 text-sm text-muted">{nav}</nav> : null}
        <div className={`flex min-w-0 items-center gap-3 ${nav ? "mt-3" : ""}`}>
          <Link className="shrink-0 rounded-xl no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" href="/dashboard" aria-label="Back to dashboard">
            <Image className="h-11 w-11 rounded-xl shadow-sm" src="/icon.png" alt="" width={44} height={44} unoptimized />
          </Link>
          <div className="min-w-0">
            <p className="font-mono text-xs uppercase tracking-[0.18em] text-muted">Kinic Wiki</p>
            <div className="mt-1 flex min-w-0 items-center gap-2">
              <h1 className="min-w-0 truncate text-3xl font-semibold text-ink">{title}</h1>
              {titleAction ? <div className="shrink-0">{titleAction}</div> : null}
            </div>
          </div>
        </div>
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}
