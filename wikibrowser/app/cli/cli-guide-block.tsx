"use client";

import type { ReactNode } from "react";
import { useState } from "react";
import { Check, Copy } from "lucide-react";

export function CliGuideBlock({
  children,
  commands,
  copyValue,
  icon,
  title
}: {
  children: ReactNode;
  commands: string[];
  copyValue?: string;
  icon: ReactNode;
  title: string;
}) {
  const [copied, setCopied] = useState(false);
  const commandText = commands.join("\n");

  async function copyCommands() {
    try {
      await navigator.clipboard.writeText(copyValue ?? commandText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section className="min-w-0 rounded-lg border border-line bg-paper p-5">
      <div className="flex items-center gap-2">
        <span className="text-accent">{icon}</span>
        <h2 className="text-lg font-semibold text-ink">{title}</h2>
      </div>
      <p className="mt-3 text-sm leading-6 text-muted">{children}</p>
      <div className="mt-4 relative overflow-hidden rounded-lg border border-line bg-white">
        <div className="absolute right-2 top-2 z-10">
          <button
            aria-label={`Copy ${title} commands`}
            className="inline-flex size-8 items-center justify-center rounded-lg border border-line bg-white text-muted shadow-[0_4px_10px_#14142b0a] hover:border-accent hover:text-accent"
            title={`Copy ${title} commands`}
            type="button"
            onClick={() => void copyCommands()}
          >
            {copied ? <Check aria-hidden size={15} /> : <Copy aria-hidden size={15} />}
          </button>
        </div>
        <pre className="max-w-full overflow-x-auto p-4 pr-14 text-xs leading-6 text-ink">
          <code>{commandText}</code>
        </pre>
      </div>
    </section>
  );
}
