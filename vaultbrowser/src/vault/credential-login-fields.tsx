import { useLayoutEffect, useRef, useState } from "react";
import { Eye, EyeOff, Trash2 } from "lucide-react";
import { CopyPasswordButton } from "../copy-button";
import { type CredentialLogin } from "./credential";
import { VaultButton, VaultField } from "./ui";

export function CredentialLoginFields({
  login, number, focusUsername, readOnly, disabled, onChange, onRemove,
}: {
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
      <VaultField
        ref={usernameInput}
        label="Username"
        value={login.username}
        disabled={readOnly}
        onChange={(e) => onChange({ ...login, username: e.target.value })}
      />
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
        </div>
      </div>
      <VaultField
        fieldClassName="vault-credential-wide"
        label="URL (stored as text)"
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
