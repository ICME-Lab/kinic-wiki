import type { ReactNode } from "react";
import { ArrowUpRight, LockKeyhole } from "lucide-react";

export function VaultChrome({ actions }: { actions?: ReactNode }) {
  return (
    <header className="vault-chrome chrome-material">
      <div className="vault-chrome-inner">
        <a className="vault-brand" href="/" aria-label="Kinic Vault home">
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
          <a
            href="https://wiki.kinic.xyz/dashboard"
            rel="noreferrer noopener"
            referrerPolicy="no-referrer"
          >
            Back to Wiki
            <ArrowUpRight size={14} aria-hidden />
          </a>
          {actions}
        </div>
      </div>
    </header>
  );
}
