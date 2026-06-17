// Where: shared wikibrowser management UI.
// What: small visual primitives for admin pages.
// Why: dashboard, marketplace, cycles, and CLI should use one visual language.

import type { ReactNode } from "react";
import { CheckCircle2, CircleAlert, Info } from "lucide-react";

type AdminNoticeTone = "info" | "success" | "warning" | "error";

export function AdminPanel({ children, padding = "md", className = "", ariaLabel }: { children: ReactNode; padding?: "none" | "sm" | "md" | "lg"; className?: string; ariaLabel?: string }) {
  const paddingClass = padding === "none" ? "" : padding === "sm" ? "p-3" : padding === "lg" ? "p-5" : "p-4";
  return <section aria-label={ariaLabel} className={`rounded-lg border border-line bg-paper shadow-sm ${paddingClass} ${className}`.trim()}>{children}</section>;
}

export function AdminNotice({ tone, message }: { tone: AdminNoticeTone; message: string }) {
  const Icon = tone === "success" ? CheckCircle2 : tone === "info" ? Info : CircleAlert;
  const toneClass =
    tone === "success"
      ? "border-green-200 bg-green-50 text-green-900"
      : tone === "error"
        ? "border-red-200 bg-red-50 text-red-900"
        : tone === "warning"
          ? "border-amber-200 bg-amber-50 text-amber-950"
          : "border-infoLine bg-infoSoft text-ink";
  return (
    <div className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${toneClass}`}>
      <Icon aria-hidden className="mt-0.5 shrink-0" size={16} />
      <span className="break-words">{message}</span>
    </div>
  );
}

export function AdminPageHeader({ actions, description, title }: { actions?: ReactNode; description?: ReactNode; title: string }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold text-ink">{title}</h1>
        {description ? <p className="mt-1 text-sm leading-6 text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">{actions}</div> : null}
    </div>
  );
}

export function AdminIconButton({ children, label, onClick, title }: { children: ReactNode; label: string; onClick: () => void; title?: string }) {
  return (
    <button
      aria-label={label}
      className="inline-flex size-10 items-center justify-center rounded-lg border border-line bg-white text-muted shadow-[0_4px_10px_#14142b0a] hover:border-accent hover:text-accentText focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
      title={title ?? label}
      type="button"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function AdminField({ label, value, breakAll = false, mono = false }: { label: string; value: ReactNode; breakAll?: boolean; mono?: boolean }) {
  return (
    <div className="grid gap-1">
      <span className="text-xs font-semibold uppercase text-muted">{label}</span>
      <span className={`${breakAll ? "break-all" : "break-words"} ${mono ? "font-mono text-sm" : "text-sm"} text-ink`}>{value}</span>
    </div>
  );
}
