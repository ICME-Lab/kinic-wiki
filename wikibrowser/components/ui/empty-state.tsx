// Where: every screen that can be empty, unauthenticated, or missing data.
// What: one empty-state layout with an icon, a plain-language reason, and the next action.
// Why: a bare grey sentence leaves users unsure whether the page is broken or simply empty.

import type { ReactNode } from "react";

export function EmptyState({
  action,
  className = "",
  description,
  icon,
  secondaryAction,
  title
}: {
  action?: ReactNode;
  className?: string;
  description?: ReactNode;
  icon?: ReactNode;
  secondaryAction?: ReactNode;
  title: string;
}) {
  return (
    <div className={`flex flex-col items-center justify-center gap-3 px-6 py-12 text-center ${className}`}>
      {icon ? (
        <span className="grid size-11 place-items-center rounded-2xl bg-accentSoft text-accentText" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <h2 className="max-w-md text-base font-semibold text-ink">{title}</h2>
      {description ? <p className="max-w-md text-sm leading-6 text-muted">{description}</p> : null}
      {action || secondaryAction ? (
        <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
          {action}
          {secondaryAction}
        </div>
      ) : null}
    </div>
  );
}
