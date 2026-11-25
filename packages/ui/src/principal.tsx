// Where: account, recipient and member rows in Vault and the Wiki credit bridge.
// What: one shortened principal with the full value on hover and a copy button.
// Why: full 63-character principals wrapped across several lines and buried the page.

import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";

/** "xjdz6-wp3o7-…-futn6-wae" → "xjdz6-wp3o7…futn6-wae": enough groups to compare at a glance. */
export function formatPrincipal(text: string): string {
  const groups = text.split("-");
  if (groups.length <= 4) return text;
  return `${groups.slice(0, 2).join("-")}…${groups.slice(-2).join("-")}`;
}

export function PrincipalText({ value, className = "", copy = true }: { value: string; className?: string; copy?: boolean }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <span className={`inline-flex min-w-0 max-w-full items-center gap-1 align-middle ${className}`}>
      <code className="min-w-0 truncate font-mono text-[0.92em]" title={value}>
        {formatPrincipal(value)}
      </code>
      {copy ? (
        <button
          type="button"
          className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted hover:bg-black/5 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          aria-label={copied ? "Principal copied" : `Copy principal ${value}`}
          title={copied ? "Copied" : "Copy full principal"}
          onClick={() => {
            void navigator.clipboard?.writeText(value).then(() => setCopied(true), () => {});
          }}
        >
          {copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
        </button>
      ) : null}
    </span>
  );
}
