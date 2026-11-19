"use client";

import { ChevronDown, LockKeyhole } from "lucide-react";
import { useId, useState } from "react";

export function VaultReferenceCard({ href }: { href: string }) {
  const [open, setOpen] = useState(false);
  const frameId = useId();
  return (
    <div className="my-4 overflow-hidden rounded-lg border border-line bg-paper">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? frameId : undefined}
        className="flex min-h-11 w-full items-center gap-2 px-4 py-2 text-left text-sm font-semibold text-ink hover:bg-accentSoft focus-visible:outline focus-visible:-outline-offset-2 focus-visible:outline-accent"
        onClick={() => setOpen(!open)}
      >
        <LockKeyhole aria-hidden="true" size={16} />
        {open ? "Close private document" : "Open private document"}
        <ChevronDown aria-hidden="true" className={open ? "ml-auto rotate-180" : "ml-auto"} size={16} />
      </button>
      {open ? (
        <iframe
          id={frameId}
          className="block h-[32rem] w-full border-0 border-t border-line"
          src={href}
          title="Private Vault document"
          referrerPolicy="no-referrer"
          sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-downloads"
        />
      ) : null}
    </div>
  );
}
