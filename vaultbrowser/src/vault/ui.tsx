import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
} from "react";
export function VaultButton({
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={`min-h-10 rounded-lg border border-line bg-white px-3 py-2 text-sm font-semibold text-ink hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
      {...props}
    />
  );
}
export function VaultField({
  label,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return (
    <label className="grid min-w-0 gap-1 text-sm font-medium">
      {label}
      <input
        className="min-h-10 min-w-0 rounded-lg border border-line bg-white px-3 py-2 text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
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
}: {
  sensitive?: boolean;
  children: ReactNode;
  label: string;
}) {
  return (
    <section
      aria-label={label}
      data-vault-sensitive={sensitive ? "true" : undefined}
      className="grid min-w-0 content-start gap-4 rounded-xl border border-line bg-white p-4"
    >
      {children}
    </section>
  );
}
const errors: Record<string, string> = {
  FileSelectionCancelled:
    "File selection stopped. Preparation is incomplete; resume with the saved files or cancel the attempt.",
  RecoveryFileTooLarge:
    "The selected file is too large. Recovery kits are limited to 4 KiB and backup archives to 256 MiB.",
  CurrentLiveKitRequired:
    "Select the recovery kit for the current live Vault, separately from an older source backup kit.",
  TargetChanged:
    "The recovery target changed. Refresh its status and select the files for the current attempt.",
  PreparedArchiveMismatch:
    "The prepared backup does not match this restoration attempt. Select its exact saved target backup and new kit.",
  ExplicitCancelRequired:
    "This target has already been prepared. Resume with the saved files, or cancel this exact attempt before creating a replacement.",
  FreshScopedProofRequired:
    "Verify the current scoped source passkey before continuing empty creation.",
  FreshIncidentProofRequired:
    "Verify a trusted remaining passkey before continuing this incident.",
  FreshRestoreProofRequired:
    "Resume with the source files and replacement passkey before continuing restoration.",
  ChoosePasskey:
    "Choose the registered passkey that authorizes this Vault or account action.",
  FreshProofRequired: "Unlock with a registered passkey before making changes.",
  GrantExpired: "The passkey session expired. Lock and unlock the Vault again.",
  LegacyRecoveryRequired:
    "This legacy Vault requires the recovery workflow. Encrypted backup remains available.",
  ResolvePendingMutation:
    "Retry the pending signed request before starting another change.",
  NoPendingMutation: "There is no signed request waiting for a retry.",
  InvalidKit:
    "Select the recovery kit for this exact Vault generation, or enter its recovery secret.",
  TitleRequired: "Enter a document title before saving.",
  Unauthorized:
    "This action requires the Vault owner. Check your sign-in and Vault sign-in.",
  Conflict:
    "Another update changed this document. Refresh the list and open it again.",
  QuotaExceeded:
    "A storage, operation or cycles limit was reached. Check your prepaid cycles balance.",
  SizeLimit:
    "Attachments are limited to 10 MiB; notes and credentials to 256 KiB.",
  Busy: "An operation is pending. Continue the same cleanup action or retry the pending signed request.",
  Expired: "This operation expired. Start it again.",
  Locked: "Vault locked. Unlock it again to continue.",
  RecoveryConfirmationMismatch:
    "The recovery secret does not match. Re-enter the saved value.",
  ExportInProgress:
    "Finish or cancel the active backup before permanently deleting a document.",
  ConnectionInterrupted:
    "The connection was interrupted after retrying. Pending uploads expire after 24 hours.",
  InvalidProof:
    "Passkey verification failed. Check that you are using the configured Vault origin.",
  VaultDisabled:
    "Vault writes and passkeys are unavailable until the administrator configures this origin.",
  UnsupportedKey:
    "This Vault uses an unsupported key service anchor. Use recovery-secret export or a compatible client.",
  KeyService:
    "The key service is unavailable. You can still export using your recovery secret.",
};
export function vaultError(error: unknown) {
  // Never display serialized server payloads, exception text, titles or plaintext.
  return (
    errors[error instanceof Error ? error.message : ""] ??
    "The Vault operation failed. Check your connection, passkey or recovery secret and try again."
  );
}
