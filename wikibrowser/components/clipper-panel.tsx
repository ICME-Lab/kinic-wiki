// Where: wikibrowser left sidebar.
// What: Chrome extension setup and database readiness panel.
// Why: Browser capture needs a visible bridge between WikiBrowser state and Clipper settings.
"use client";

import type { Identity } from "@icp-sdk/core/agent";
import type { ReactNode } from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, ExternalLink, FileText, Link2, MessageSquareText } from "lucide-react";
import type { DatabaseRole } from "@/lib/types";

export function ClipperPanel({
  databaseId,
  ingestHref,
  readIdentity,
  currentDatabaseRole,
  databaseCyclesError
}: {
  databaseId: string;
  ingestHref: string;
  readIdentity: Identity | null;
  currentDatabaseRole: DatabaseRole | null;
  databaseCyclesError: string | null;
}) {
  const principal = readIdentity?.getPrincipal().toText() ?? null;
  const writeStatus = clipperWriteStatus(readIdentity, currentDatabaseRole, databaseCyclesError);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4 text-sm">
      <section className={`rounded-xl border p-4 ${writeStatus.ok ? "border-emerald-200 bg-emerald-50 text-emerald-950" : "border-amber-200 bg-amber-50 text-amber-950"}`}>
        <div className="flex items-start gap-2">
          <span className="mt-0.5 shrink-0">{writeStatus.ok ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}</span>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold">{writeStatus.title}</h3>
            <p className="mt-1 text-xs leading-5">{writeStatus.message}</p>
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-line bg-white p-4">
        <h3 className="text-sm font-semibold">Current database</h3>
        <dl className="mt-3 grid gap-3">
          <StatusRow label="Database" value={databaseId} />
          <StatusRow label="Principal" value={principal ?? "Not logged in"} />
          <StatusRow label="Role" value={currentDatabaseRole ?? "Unavailable"} />
        </dl>
      </section>

      <section className="rounded-xl border border-line bg-white p-4">
        <h3 className="text-sm font-semibold">Capture flows</h3>
        <div className="mt-3 grid gap-2">
          <FlowRow icon={<Link2 size={15} />} title="Active tab snapshot" path="/Sources/raw/web/..." />
          <FlowRow icon={<MessageSquareText size={15} />} title="ChatGPT export" path="/Sources/raw/chatgpt/..." />
          <FlowRow icon={<FileText size={15} />} title="Claude export" path="/Sources/raw/claude/..." />
        </div>
      </section>

      <section className="rounded-xl border border-line bg-white p-4">
        <h3 className="text-sm font-semibold">Extension settings</h3>
        <ol className="mt-3 grid gap-2 text-xs leading-5 text-muted">
          <li>1. Open <span className="font-mono text-ink">chrome://extensions</span>.</li>
          <li>2. Select <span className="font-semibold text-ink">Kinic Wiki Clipper</span>.</li>
          <li>3. Open <span className="font-semibold text-ink">Extension options</span>.</li>
          <li>4. Login and select a writable active database.</li>
        </ol>
      </section>

      <Link
        className="inline-flex items-center justify-center gap-2 rounded-2xl border border-action bg-action px-3 py-2 text-sm font-bold text-white no-underline hover:-translate-y-[3px] hover:border-accent hover:bg-accent"
        href={ingestHref}
      >
        <ExternalLink size={15} />
        Open web capture
      </Link>
    </div>
  );
}

function StatusRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">{label}</dt>
      <dd className="mt-1 break-all font-mono text-xs text-ink">{value}</dd>
    </div>
  );
}

function FlowRow({ icon, title, path }: { icon: ReactNode; title: string; path: string }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-line bg-paper px-3 py-2">
      <span className="mt-0.5 shrink-0 text-accent">{icon}</span>
      <div className="min-w-0">
        <div className="text-xs font-semibold">{title}</div>
        <div className="mt-1 break-all font-mono text-[11px] text-muted">{path}</div>
      </div>
    </div>
  );
}

function clipperWriteStatus(
  readIdentity: Identity | null,
  currentDatabaseRole: DatabaseRole | null,
  databaseCyclesError: string | null
): { ok: boolean; title: string; message: string } {
  if (!readIdentity) {
    return {
      ok: false,
      title: "Login required",
      message: "WikiBrowser is not logged in. Use the same Internet Identity in the extension settings."
    };
  }
  if (!currentDatabaseRole) {
    return {
      ok: false,
      title: "Database role unavailable",
      message: "The current principal has no loaded writer or owner role for this database."
    };
  }
  if (currentDatabaseRole !== "writer" && currentDatabaseRole !== "owner") {
    return {
      ok: false,
      title: "Writer access required",
      message: "Clipper writes need writer or owner access to the selected database."
    };
  }
  if (databaseCyclesError) {
    return {
      ok: false,
      title: "Cycles unavailable",
      message: databaseCyclesError
    };
  }
  return {
    ok: true,
    title: "Ready for capture",
    message: "Use the extension settings to select this writable database before capture."
  };
}
