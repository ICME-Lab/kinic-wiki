"use client";

// Where: documentation, guides, and any surface that shows copyable commands.
// What: a code block with its own header bar so the copy action never overlaps the code.
// Why: the previous inline overlay sat on top of long commands and hid the text it was copying.

import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export function CodeBlock({
  className = "",
  code,
  copyValue,
  label = "bash",
  size = "sm"
}: {
  className?: string;
  code: string;
  copyValue?: string;
  label?: string;
  size?: "sm" | "md";
}) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const timeout = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timeout.current !== null) window.clearTimeout(timeout.current);
    };
  }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(copyValue ?? code);
      setCopied(true);
      setFailed(false);
    } catch {
      setCopied(false);
      setFailed(true);
    }
    if (timeout.current !== null) window.clearTimeout(timeout.current);
    timeout.current = window.setTimeout(() => {
      setCopied(false);
      setFailed(false);
    }, 1600);
  }

  const statusLabel = copied ? "Copied" : failed ? "Copy failed" : "Copy";

  return (
    <figure className={`min-w-0 overflow-hidden rounded-xl border border-line bg-paper ${className}`}>
      <figcaption className="flex items-center justify-between gap-3 border-b border-line px-3 py-1.5">
        <span className="min-w-0 truncate font-mono text-[11px] uppercase tracking-[0.12em] text-muted">{label}</span>
        <button
          aria-label={`${statusLabel} ${label} code`}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 font-mono text-[11px] uppercase tracking-[0.08em] text-muted transition-colors hover:bg-accentSoft hover:text-accentText disabled:opacity-60"
          type="button"
          onClick={() => void copy()}
        >
          {copied ? <Check aria-hidden size={13} /> : <Copy aria-hidden size={13} />}
          <span aria-live="polite">{statusLabel}</span>
        </button>
      </figcaption>
      <pre
        className={`max-w-full overflow-x-auto px-3 py-3 font-mono leading-6 text-ink ${
          size === "md" ? "text-[13px]" : "text-xs"
        }`}
      >
        <code>{code}</code>
      </pre>
    </figure>
  );
}
