import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, Copy, KeyRound, RefreshCw, ShieldCheck, Wand2 } from "lucide-react";
import type { VaultClient } from "@kinic/vault-client";
import {
  DEFAULT_PASSPHRASE_OPTIONS,
  DEFAULT_PASSWORD_OPTIONS,
  estimatePasswordStrength,
  estimatePassphraseStrength,
  generatePassphrase,
  generatePassword,
  type PassphraseOptions,
  type PasswordOptions,
} from "@kinic/vault-crypto/password";
import {
  formatTotpCode,
  generateTotp,
  type TotpCode,
} from "@kinic/vault-crypto/totp";
import { VaultButton } from "./ui";

export function CopyValueButton({
  value,
  label,
  disabled,
}: {
  value: string;
  label: string;
  disabled: boolean;
}) {
  const [status, setStatus] = useState(label);
  const lifecycle = useRef<{ epoch: number; timer: number | undefined }>({
    epoch: 0,
    timer: undefined,
  });

  useLayoutEffect(() => {
    const owned = lifecycle.current;
    owned.epoch++;
    setStatus(label);
    return () => {
      owned.epoch++;
      window.clearTimeout(owned.timer);
    };
  }, [value, label]);

  const copy = async () => {
    const owned = lifecycle.current;
    const ticket = ++owned.epoch;
    window.clearTimeout(owned.timer);
    setStatus("Copying…");
    try {
      await navigator.clipboard.writeText(value);
      if (owned.epoch === ticket) setStatus("Copied");
    } catch {
      if (owned.epoch === ticket) setStatus("Copy failed");
    } finally {
      if (owned.epoch === ticket) {
        owned.timer = window.setTimeout(() => setStatus(label), 2500);
      }
    }
  };

  return (
    <VaultButton
      size="sm"
      disabled={disabled || !value || status === "Copying…"}
      onClick={() => {
        void copy();
      }}
    >
      {status === "Copied" ? (
        <Check size={14} aria-hidden />
      ) : (
        <Copy size={14} aria-hidden />
      )}
      <span aria-live="polite">{status}</span>
    </VaultButton>
  );
}

const STRENGTH_LABELS: Record<
  ReturnType<typeof estimatePasswordStrength>["level"],
  string
> = {
  weak: "Weak",
  fair: "Fair",
  strong: "Strong",
  "very-strong": "Very strong",
};

export function PasswordStrengthBadge({ password, strength }: { password: string; strength?: ReturnType<typeof estimatePasswordStrength> }) {
  if (!password) return null;
  const { level, entropyBits } = strength ?? estimatePasswordStrength(password);
  return (
    <span
      className={`vault-strength vault-strength--${level}`}
      title={`Estimated ${Math.round(entropyBits)} bits of entropy`}
    >
      <ShieldCheck size={12} aria-hidden />
      {STRENGTH_LABELS[level]}
    </span>
  );
}

export function PasswordGeneratorPanel({
  client,
  disabled,
  onUse,
}: {
  client: VaultClient;
  disabled: boolean;
  onUse: (password: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"random" | "passphrase">("random");
  const [passwordOpts, setPasswordOpts] = useState<PasswordOptions>(
    DEFAULT_PASSWORD_OPTIONS,
  );
  const [phraseOpts, setPhraseOpts] = useState<PassphraseOptions>(
    DEFAULT_PASSPHRASE_OPTIONS,
  );
  const [preview, setPreview] = useState("");

  const regenerate = useCallback(
    (
      nextMode: "random" | "passphrase",
      nextPasswordOpts: PasswordOptions,
      nextPhraseOpts: PassphraseOptions,
    ) => {
      setPreview(
        nextMode === "random"
          ? generatePassword(nextPasswordOpts)
          : generatePassphrase(nextPhraseOpts),
      );
    },
    [],
  );

  useLayoutEffect(() => {
    const detach = client.session.addLockCleanup(() => {
      setOpen(false);
      setPreview("");
    });
    return () => {
      detach();
    };
  }, [client]);

  const toggleOpen = () => {
    if (!open) {
      regenerate(mode, passwordOpts, phraseOpts);
    } else {
      setPreview("");
    }
    setOpen(!open);
  };

  if (disabled && !open) {
    return null;
  }

  return (
    <div className="vault-generator-wrap">
      <VaultButton
        size="sm"
        aria-expanded={open}
        disabled={disabled}
        onClick={toggleOpen}
      >
        <Wand2 size={14} aria-hidden />
        {open ? "Close generator" : "Generate password"}
      </VaultButton>
      {open ? (
        <div className="vault-generator" role="region" aria-label="Password generator">
          <div className="vault-generator-modes">
            <VaultButton
              size="sm"
              tone={mode === "random" ? "primary" : "ghost"}
              onClick={() => {
                setMode("random");
                regenerate("random", passwordOpts, phraseOpts);
              }}
            >
              Random
            </VaultButton>
            <VaultButton
              size="sm"
              tone={mode === "passphrase" ? "primary" : "ghost"}
              onClick={() => {
                setMode("passphrase");
                regenerate("passphrase", passwordOpts, phraseOpts);
              }}
            >
              Passphrase
            </VaultButton>
          </div>
          <div className="vault-generator-preview">
            <code className="vault-generator-code" data-vault-sensitive="true">
              {preview}
            </code>
            <PasswordStrengthBadge password={preview} strength={mode === "passphrase" ? estimatePassphraseStrength(phraseOpts) : undefined} />
          </div>
          {mode === "random" ? (
            <div className="vault-generator-options">
              <label className="vault-generator-range">
                <span>Length: {passwordOpts.length}</span>
                <input
                  type="range"
                  min={8}
                  max={64}
                  value={passwordOpts.length}
                  onChange={(e) => {
                    const next = { ...passwordOpts, length: Number(e.target.value) };
                    setPasswordOpts(next);
                    regenerate("random", next, phraseOpts);
                  }}
                />
              </label>
              <div className="vault-generator-checks">
                {(
                  [
                    ["uppercase", "A-Z"],
                    ["lowercase", "a-z"],
                    ["digits", "0-9"],
                    ["symbols", "!@#"],
                    ["excludeAmbiguous", "No 0O1lI"],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key} className="vault-generator-check">
                    <input
                      type="checkbox"
                      checked={passwordOpts[key]}
                      onChange={(e) => {
                        const next = { ...passwordOpts, [key]: e.target.checked };
                        setPasswordOpts(next);
                        regenerate("random", next, phraseOpts);
                      }}
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
            </div>
          ) : (
            <div className="vault-generator-options">
              <label className="vault-generator-range">
                <span>Words: {phraseOpts.words}</span>
                <input
                  type="range"
                  min={3}
                  max={8}
                  value={phraseOpts.words}
                  onChange={(e) => {
                    const next = { ...phraseOpts, words: Number(e.target.value) };
                    setPhraseOpts(next);
                    regenerate("passphrase", passwordOpts, next);
                  }}
                />
              </label>
              <div className="vault-generator-checks">
                <label className="vault-generator-check">
                  <input
                    type="checkbox"
                    checked={phraseOpts.capitalize}
                    onChange={(e) => {
                      const next = { ...phraseOpts, capitalize: e.target.checked };
                      setPhraseOpts(next);
                      regenerate("passphrase", passwordOpts, next);
                    }}
                  />
                  <span>Capitalize</span>
                </label>
                <label className="vault-generator-check">
                  <input
                    type="checkbox"
                    checked={phraseOpts.includeNumber}
                    onChange={(e) => {
                      const next = { ...phraseOpts, includeNumber: e.target.checked };
                      setPhraseOpts(next);
                      regenerate("passphrase", passwordOpts, next);
                    }}
                  />
                  <span>Include number</span>
                </label>
              </div>
            </div>
          )}
          <div className="vault-generator-actions">
            <VaultButton
              size="sm"
              onClick={() => regenerate(mode, passwordOpts, phraseOpts)}
            >
              <RefreshCw size={14} aria-hidden />
              Regenerate
            </VaultButton>
            <VaultButton
              size="sm"
              tone="primary"
              disabled={!preview || disabled}
              onClick={() => {
                onUse(preview);
                setOpen(false);
                setPreview("");
              }}
            >
              Use password
            </VaultButton>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function TotpLiveDisplay({
  client,
  secret,
  disabled,
}: {
  client: VaultClient;
  secret: string;
  disabled: boolean;
}) {
  const [totp, setTotp] = useState<TotpCode>();
  const [error, setError] = useState("");

  useLayoutEffect(() => {
    const detach = client.session.addLockCleanup(() => {
      setTotp(undefined);
      setError("");
    });
    return () => {
      detach();
    };
  }, [client]);

  useEffect(() => {
    const trimmed = secret.trim();
    if (!trimmed) {
      setTotp(undefined);
      setError("");
      return;
    }
    let cancelled = false;
    const ticket = client.session.capture();
    const update = async () => {
      try {
        client.session.check(ticket);
        const result = await generateTotp(trimmed);
        if (!cancelled) {
          setTotp(result);
          setError("");
        }
      } catch {
        if (!cancelled) {
          setTotp(undefined);
          setError("Enter a valid Base32 secret or otpauth://totp/ URI.");
        }
      }
    };
    void update();
    const timer = window.setInterval(() => {
      void update();
    }, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [client, secret]);

  if (!secret.trim()) return null;
  if (error) {
    return <p className="vault-field-hint vault-totp-error">{error}</p>;
  }
  if (!totp) return null;

  return (
    <div className="vault-totp-box" aria-label="One-time verification code">
      <div className="vault-totp-left">
        <KeyRound size={15} aria-hidden />
        <code className="vault-totp-code" data-vault-sensitive="true">
          {formatTotpCode(totp.code)}
        </code>
        <span className="vault-totp-timer" aria-live="off">
          {totp.remainingSeconds}s
        </span>
      </div>
      <CopyValueButton value={totp.code} label="Copy code" disabled={disabled} />
    </div>
  );
}
