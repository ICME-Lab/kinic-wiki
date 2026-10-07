import type { ReactNode } from "react";

export function PanelHeader({
  icon,
  title,
  subtitle,
  actions
}: {
  icon: ReactNode;
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex min-h-[52px] flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2.5">
      <div className="flex min-w-[8rem] flex-1 items-center gap-2">
        <span className="inline-flex shrink-0 items-center justify-center text-muted">{icon}</span>
        <div className="min-w-0">
          <h2 className="break-words text-[13px] font-semibold text-ink">{title}</h2>
          {subtitle ? <p className="truncate text-xs text-muted">{subtitle}</p> : null}
        </div>
      </div>
      {actions ? <div className="ml-auto shrink-0">{actions}</div> : null}
    </div>
  );
}

export function InspectorCard({
  title,
  icon,
  children
}: {
  title: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-line bg-white p-4 shadow-card">
      <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <span className="text-accentText">{icon}</span>
        {title}
      </h3>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

export function Meta({ label, title, value }: { label: string; title?: string; value: string | null }) {
  return (
    <div className="min-w-0">
      <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">{label}</div>
      <div className="mt-1 min-w-0 [overflow-wrap:anywhere] font-mono text-xs text-ink" title={title}>
        {value ?? "-"}
      </div>
    </div>
  );
}

export function ErrorBox({ message, hint }: { message: string; hint?: string | null }) {
  return (
    <div className="rounded-xl border border-dangerLine bg-dangerSoft p-3 text-sm text-dangerText">
      <p>{message}</p>
      {hint ? <p className="mt-2 text-xs leading-5 text-dangerText opacity-90">{hint}</p> : null}
    </div>
  );
}
