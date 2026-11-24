import { useLayoutEffect, useRef, useState } from "react";
import { Eye, EyeOff, Trash2 } from "lucide-react";
import type { VaultClient } from "@kinic/vault-client";
import { CopyPasswordButton } from "../copy-button";
import { type CredentialLogin } from "./credential";
import {
  CopyValueButton,
  PasswordGeneratorPanel,
  PasswordStrengthBadge,
} from "./credential-tools";
import { VaultButton, VaultField } from "./ui";

export function CredentialLoginFields({
  client, login, number, focusUsername, readOnly, disabled, onChange, onRemove,
}: {
  client?: VaultClient;
  login: CredentialLogin;
  number: number;
  focusUsername?: boolean;
  readOnly: boolean;
  disabled: boolean;
  onChange: (login: CredentialLogin) => void;
  onRemove?: () => void;
}) {
  const [reveal, setReveal] = useState(false);
  const usernameInput = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    if (focusUsername) usernameInput.current?.focus();
  }, [focusUsername]);
  return (
    <fieldset className="vault-credential-login">
      <legend>Login {number}</legend>
      <div className="vault-credential-row">
        <VaultField
          ref={usernameInput}
          label="Username"
          value={login.username}
          disabled={readOnly}
          onChange={(e) => onChange({ ...login, username: e.target.value })}
        />
        <div className="vault-inline-actions">
          <CopyValueButton
            value={login.username}
            label="Copy username"
            disabled={disabled}
          />
        </div>
      </div>
      <div className="vault-password">
        <VaultField
          label="Password"
          type={reveal ? "text" : "password"}
          value={login.password}
          disabled={readOnly}
          onChange={(e) => onChange({ ...login, password: e.target.value })}
        />
        <div className="vault-password-actions">
          <VaultButton
            size="sm"
            aria-pressed={reveal}
            disabled={disabled}
            onClick={() => setReveal(!reveal)}
          >
            {reveal ? <EyeOff size={14} aria-hidden /> : <Eye size={14} aria-hidden />}
            {reveal ? "Hide password" : "Show password"}
          </VaultButton>
          <CopyPasswordButton value={login.password} disabled={disabled} />
          <PasswordStrengthBadge password={login.password} />
        </div>
        {client ? (
          <PasswordGeneratorPanel
            client={client}
            disabled={readOnly}
            onUse={(generated) => onChange({ ...login, password: generated })}
          />
        ) : null}
      </div>
      <VaultField
        fieldClassName="vault-credential-wide"
        label="URL (stored as text)"
        placeholder="https://example.com"
        value={login.url}
        disabled={readOnly}
        onChange={(e) => onChange({ ...login, url: e.target.value })}
      />
      {onRemove ? (
        <div className="vault-credential-wide">
          <VaultButton size="sm" tone="ghost" disabled={readOnly} onClick={onRemove}>
            <Trash2 size={14} aria-hidden />
            Remove login
          </VaultButton>
        </div>
      ) : null}
    </fieldset>
  );
}
