// Where: dashboards, listings, and inspectors that report a state.
// What: one status pill so "active", "low balance" and "suspended" read the same everywhere.
// Why: status colour was previously re-invented per screen and contradicted the billing config.

import type { ReactNode } from "react";

export type StatusTone = "neutral" | "accent" | "positive" | "warn" | "danger" | "info";

export function StatusPill({
  className = "",
  dot = false,
  icon,
  label,
  title,
  tone = "neutral"
}: {
  className?: string;
  dot?: boolean;
  icon?: ReactNode;
  label: ReactNode;
  title?: string;
  tone?: StatusTone;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-medium ${toneClass(tone)} ${className}`}
      aria-label={title}
      title={title}
    >
      {dot ? <span className={`size-1.5 shrink-0 rounded-full ${dotClass(tone)}`} aria-hidden="true" /> : null}
      {icon}
      <span className="min-w-0 truncate">{label}</span>
    </span>
  );
}

function toneClass(tone: StatusTone): string {
  if (tone === "accent") return "border-accentLine bg-accentSoft text-accentText";
  if (tone === "positive") return "border-okLine bg-okSoft text-okText";
  if (tone === "warn") return "border-warnLine bg-warnSoft text-warnText";
  if (tone === "danger") return "border-dangerLine bg-dangerSoft text-dangerText";
  if (tone === "info") return "border-infoLine bg-infoSoft text-infoText";
  return "border-line bg-paper text-muted";
}

function dotClass(tone: StatusTone): string {
  if (tone === "accent") return "bg-accent";
  if (tone === "positive") return "bg-emerald-500";
  if (tone === "warn") return "bg-amber-500";
  if (tone === "danger") return "bg-red-500";
  if (tone === "info") return "bg-kinicCyan";
  return "bg-muted";
}
