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
    <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
      <div className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 text-accent">{icon}</span>
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold">{title}</h2>
          {subtitle ? <p className="truncate text-xs text-muted">{subtitle}</p> : null}
        </div>
      </div>
      {actions ? <div className="shrink-0">{actions}</div> : null}
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
    <section className="rounded-xl border border-line bg-white p-4">
      <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <span className="text-accent">{icon}</span>
        {title}
      </h3>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

export function Meta({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">{label}</div>
      <div className="mt-1 break-all font-mono text-xs text-ink">{value ?? "-"}</div>
    </div>
  );
}

export function ErrorBox({ message, hint }: { message: string; hint?: string | null }) {
  return (
    <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
      <p>{message}</p>
      {hint ? <p className="mt-2 text-xs leading-5 text-red-600">{hint}</p> : null}
    </div>
  );
}
