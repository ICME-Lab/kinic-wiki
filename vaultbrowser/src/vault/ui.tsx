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
  size = "md",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: "default" | "primary" | "danger" | "ghost";
  size?: "sm" | "md" | "lg" | "icon";
}) {
  return (
    <Button
      variant={tone === "primary" ? "default" : tone === "danger" ? "destructive" : tone === "ghost" ? "ghost" : "outline"}
      size={size === "md" ? "default" : size}
      type="button"
      className={`vault-button ${className}`}
      {...props}
    />
  );
}
export function VaultField({
  label,
  labelHidden = false,
  fieldClassName = "",
  ref,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  labelHidden?: boolean;
  fieldClassName?: string;
  ref?: React.Ref<HTMLInputElement>;
}) {
  return (
    <label className={`vault-field ${fieldClassName}`}>
      <span className={labelHidden ? "sr-only" : undefined}>{label}</span>
      <Input
        ref={ref}
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
      className={`vault-panel ${className}`}
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
    "Your Internet Identity does not have access to this Vault or action.",
  InvalidMemberPrincipal: "Enter the Vault principal of the person you want to add.",
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
  KeyFundingRequired:
    "Add prepaid balance here to retrieve this Vault's key. Saved keys can still be used without a retrieval fee.",
  ServiceReserveLow:
    "New paid operations are paused because the Vault service cycles reserve is low.",
  BalanceUnavailable:
    "The operation finished, but the balance could not be refreshed. Refresh balance before starting another paid operation.",
  KeyService:
    "The key service is unavailable. Select this Vault to retry opening it.",
};
export function vaultError(error: unknown, ownerPays = false) {
  if (ownerPays && error instanceof Error && error.message === "QuotaExceeded")
    return "This Vault reached a storage, operation or credit limit. The Vault owner's prepaid balance covers shared access.";
  // Never display serialized server payloads, exception text, titles or plaintext.
  return (
    errors[error instanceof Error ? error.message : ""] ??
    "The Vault operation failed. Check your connection and try the same operation again."
  );
}
