// Where: shared admin pages in wikibrowser.
// What: renders the common Kinic Wiki admin header shell.
// Why: dashboard, database management, and Skill Registry should present one management UI shape.
import { AppLink as Link } from "@/components/app-link";
import type { ReactNode } from "react";

export function AdminHeader({ actions, nav, title, titleAction }: { actions?: ReactNode; nav?: ReactNode; title: string; titleAction?: ReactNode }) {
  return (
    <header className="flex flex-col gap-3 border-b border-line pb-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        {nav ? <nav className="flex flex-wrap items-center gap-2 text-sm text-muted">{nav}</nav> : null}
        <div className={`flex min-w-0 items-center gap-3 ${nav ? "mt-3" : ""}`}>
          <Link className="shrink-0 rounded-xl no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" href="/dashboard" aria-label="Back to dashboard">
            <img className="h-8 w-8 rounded-lg" src="/kinic-mark.png" alt="" width={32} height={32} />
          </Link>
          <div className="min-w-0">
            <p className="text-[11px] font-medium text-muted">Kinic Wiki</p>
            <div className="flex min-w-0 items-center gap-2">
              <h1 className="min-w-0 truncate text-lg font-semibold leading-tight tracking-[-0.01em] text-ink">{title}</h1>
              {titleAction ? <div className="shrink-0">{titleAction}</div> : null}
            </div>
          </div>
        </div>
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}
