import { Button } from "@kinic/ui/button";
import { Input } from "@kinic/ui/input";
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
} from "react";
export function VaultButton({
  className = "",
  tone = "default",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: "default" | "primary" | "danger";
}) {
  return (
    <Button
      unstyled
      type="button"
      className={`vault-button vault-button--${tone} ${className}`}
      {...props}
    />
  );
}
export function VaultField({
  label,
  labelHidden = false,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  labelHidden?: boolean;
}) {
  return (
    <label className="grid min-w-0 gap-1 text-sm font-medium">
      <span className={labelHidden ? "sr-only" : undefined}>{label}</span>
      <Input
        unstyled
        className="vault-input min-w-0"
        autoComplete="off"
        {...props}
      />
    </label>
  );
}
export function VaultPanel({
  children,
  label,
  sensitive = false,
  className = "",
}: {
  sensitive?: boolean;
  className?: string;
  children: ReactNode;
  label: string;
}) {
  return (
    <section
      aria-label={label}
      data-vault-sensitive={sensitive ? "true" : undefined}
      className={`vault-panel grid min-w-0 content-start gap-4 ${className}`}
    >
      {children}
    </section>
  );
}
const errors: Record<string, string> = {
  TargetChanged:
    "This Vault changed or is no longer available. Select a Vault again.",
  SavePending:
    "Resume or cancel the pending encrypted save before editing or saving again.",
  SaveInProgress: "A save is already running.",
  NoPendingSave:
    "There is no save waiting in this session. Refresh interrupted uploads to clean up earlier work.",
  ResolvePendingMutation:
    "Retry the pending request before starting another change.",
  NoPendingMutation: "There is no request waiting for a retry.",
  Unauthorized:
    "This action requires the Vault owner. Check your Internet Identity sign-in.",
  Conflict:
    "Another update changed this document or operation. Refresh and open the current version before retrying.",
  NotFound:
    "This Vault, document or upload is no longer available. Refresh the list.",
  QuotaExceeded:
    "A storage, operation or cycles limit was reached. Check your prepaid balance.",
  SizeLimit:
    "Attachments are limited to 10 MiB; notes and credentials to 256 KiB.",
  Busy: "An operation is pending. Resume or cancel it before starting another change.",
  Locked:
    "This Vault is closed. Select it to continue with your current Internet Identity.",
  NotSignedIn: "Sign in with Internet Identity to continue.",
  VaultDisabled:
    "Vault creation is unavailable until the administrator configures the service.",
  UnsupportedKey: "This Vault uses an unsupported key service anchor.",
  KeyService:
    "The key service is unavailable. Select this Vault to retry opening it.",
};
export function vaultError(error: unknown) {
  // Never display serialized server payloads, exception text, titles or plaintext.
  return (
    errors[error instanceof Error ? error.message : ""] ??
    "The Vault operation failed. Check your connection and try the same operation again."
  );
}
