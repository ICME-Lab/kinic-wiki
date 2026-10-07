"use client";

// Where: CLI and Canister API guides.
// What: one guide step whose commands render in a shared CodeBlock.
// Why: the copy control lives in the code header so it can never cover a long command.

import type { ReactNode } from "react";
import { AdminPanel } from "@/components/admin-ui";
import { CodeBlock } from "@/components/ui/code-block";

export function CliGuideBlock({
  children,
  compact = false,
  commands,
  copyValue,
  icon,
  label = "bash",
  title
}: {
  children: ReactNode;
  compact?: boolean;
  commands: string[];
  copyValue?: string;
  icon: ReactNode;
  label?: string;
  title: string;
}) {
  return (
    <AdminPanel className="min-w-0" padding={compact ? "md" : "lg"}>
      <div className="flex items-center gap-2">
        <span className="text-accentText">{icon}</span>
        <h2 className={`${compact ? "text-base" : "text-lg"} font-semibold text-ink`}>{title}</h2>
      </div>
      <p className="mt-2 text-sm leading-6 text-muted">{children}</p>
      <CodeBlock className="mt-4" code={commands.join("\n")} copyValue={copyValue} label={label} />
    </AdminPanel>
  );
}
