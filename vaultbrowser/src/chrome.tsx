import {useVaultNavigation} from "./navigation";
import type { ReactNode } from "react";
import { ArrowUpRight, LockKeyhole } from "lucide-react";

export function VaultChrome({ actions }: { actions?: ReactNode }) {
  const nav=useVaultNavigation();
  const skipTarget = nav.view === "settings" || nav.view === "vault-settings"
    ? "vault-settings-title"
    : nav.view === "help" ? "vault-help-title" : "vault-content";

  return (
    <><a
      className="vault-skip-link"
      href={skipTarget === "vault-content" ? "#vault-main" : `#${skipTarget}`}
      onClick={(event) => {
        event.preventDefault();
        const target = document.getElementById(skipTarget)
          ?? document.getElementById("vault-welcome-title")
          ?? document.getElementById("vault-main");
        target?.focus();
      }}
    >Skip to content</a>
    <header className="vault-chrome chrome-material">
      <div className="vault-chrome-inner">
        <a className="vault-brand" href="/" onClick={event=>{if(!event.ctrlKey&&!event.metaKey&&!event.shiftKey&&!event.altKey){event.preventDefault();nav.go("/");}}} aria-label="Kinic Vault home">
          <img src="/kinic-mark.png" width="30" height="30" alt="" />
          <span>
            Kinic <span className="text-muted font-normal">/</span> Vault
          </span>
        </a>
        <span className="vault-chrome-label">
          <LockKeyhole size={13} aria-hidden />
          Private space
        </span>
        <div className="vault-chrome-actions">
          <div id="vault-chrome-slot" className="vault-chrome-slot" />
          <a
            href={import.meta.env.VITE_WIKI_URL || "https://wiki.kinic.xyz/dashboard"}
            aria-label="Back to Wiki"
            title="Back to Wiki"
            rel="noreferrer noopener"
            referrerPolicy="no-referrer"
          >
            <span className="vault-back-label">Back to Wiki</span>
            <ArrowUpRight size={14} aria-hidden />
          </a>
          {actions}
        </div>
      </div>
    </header></>
  );
}
