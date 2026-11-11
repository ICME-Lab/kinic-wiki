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
}: {
  children: ReactNode;
  label: string;
}) {
  return (
    <section
      aria-label={label}
      className="grid min-w-0 content-start gap-4 rounded-xl border border-line bg-white p-4"
    >
      {children}
    </section>
  );
}
const errors: Record<string, string> = {
  TitleRequired: "Enter a document title before saving.",
  Unauthorized:
    "This action requires the Vault owner. Check your sign-in and payer database ownership.",
  Conflict:
    "Another update changed this document. Refresh the list and open it again.",
  QuotaExceeded:
    "A storage, operation or cycles limit was reached. Check your payer database and cycles balance.",
  SizeLimit:
    "Attachments are limited to 10 MiB; notes and credentials to 256 KiB.",
  Busy: "An operation is pending. Check interrupted setup or clear an interrupted key request.",
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
