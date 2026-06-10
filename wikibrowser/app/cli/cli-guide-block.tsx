"use client";

import type { ReactNode } from "react";
import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { AdminIconButton, AdminPanel } from "@/components/admin-ui";

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
    <AdminPanel className="min-w-0" padding="lg">
      <div className="flex items-center gap-2">
        <span className="text-accent">{icon}</span>
        <h2 className="text-lg font-semibold text-ink">{title}</h2>
      </div>
      <p className="mt-3 text-sm leading-6 text-muted">{children}</p>
      <div className="mt-4 relative overflow-hidden rounded-lg border border-line bg-white">
        <div className="absolute right-2 top-2 z-10">
          <AdminIconButton label={`Copy ${title} commands`} title={`Copy ${title} commands`} onClick={() => void copyCommands()}>
            {copied ? <Check aria-hidden size={15} /> : <Copy aria-hidden size={15} />}
          </AdminIconButton>
        </div>
        <pre className="max-w-full overflow-x-auto p-4 pr-14 text-xs leading-6 text-ink">
          <code>{commandText}</code>
        </pre>
      </div>
    </AdminPanel>
  );
}
