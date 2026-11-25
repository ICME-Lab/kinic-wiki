import { useLayoutEffect, useRef, useState } from "react";
import { Eye, EyeOff, Trash2 } from "lucide-react";
import { CopyPasswordButton } from "../copy-button";
import { useConfirm } from "./confirm";
import { type CredentialLogin } from "./credential";
import { VaultButton, VaultField } from "./ui";

/**
 * One login as a single compact row: username, password (with reveal and copy
 * inside the field), URL, and remove. Labels stay for assistive technology;
 * placeholders carry them visually so many logins fit on one screen.
 */
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
  const [confirm, confirmDialog] = useConfirm();
  const usernameInput = useRef<HTMLInputElement>(null);
  // The dialog can outlive the click: re-check edit access when it is answered.
  const editable = useRef(!readOnly);
  useLayoutEffect(() => {
    editable.current = !readOnly;
  }, [readOnly]);
  useLayoutEffect(() => {
    if (focusUsername) usernameInput.current?.focus();
  }, [focusUsername]);
  const revealLabel = reveal ? "Hide password" : "Show password";
  return (
    <fieldset className="vault-credential-login">
      <legend className="sr-only">Login {number}</legend>
      <span className="vault-credential-index" aria-hidden>{number}</span>
      <VaultField
        ref={usernameInput}
        label="Username"
        labelHidden
        placeholder="Username"
        value={login.username}
        disabled={readOnly}
        onChange={(e) => onChange({ ...login, username: e.target.value })}
      />
      <div className="vault-password">
        <VaultField
          label="Password"
          labelHidden
          placeholder="Password"
          type={reveal ? "text" : "password"}
          value={login.password}
          disabled={readOnly}
          onChange={(e) => onChange({ ...login, password: e.target.value })}
        />
        <div className="vault-password-actions">
          <VaultButton
            size="icon"
            tone="ghost"
            className="vault-icon-button"
            aria-label={revealLabel}
            title={revealLabel}
            aria-pressed={reveal}
            disabled={disabled}
            onClick={() => setReveal(!reveal)}
          >
            {reveal ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
          </VaultButton>
          <CopyPasswordButton value={login.password} disabled={disabled} />
        </div>
      </div>
      <VaultField
        fieldClassName="vault-credential-url"
        label="URL (stored as text)"
        labelHidden
        placeholder="URL"
        value={login.url}
        disabled={readOnly}
        onChange={(e) => onChange({ ...login, url: e.target.value })}
      />
      {onRemove ? (
        <VaultButton
          size="icon"
          tone="ghost"
          className="vault-icon-button vault-credential-remove"
          aria-label="Remove login"
          title="Remove login"
          disabled={readOnly}
          onClick={() => {
            void confirm({
              title: "Remove this login?",
              description: login.username
                ? `Login ${number} (${login.username}) is removed from this credential when you save.`
                : `Login ${number} is removed from this credential when you save.`,
              confirmLabel: "Remove",
            }).then((confirmed) => {
              if (confirmed && editable.current) onRemove();
            });
          }}
        >
          <Trash2 aria-hidden />
        </VaultButton>
      ) : <span className="vault-credential-remove" aria-hidden />}
      {confirmDialog}
    </fieldset>
  );
}
