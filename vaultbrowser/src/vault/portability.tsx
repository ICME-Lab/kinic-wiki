import { useLayoutEffect, useRef, useState } from "react";
import { ArrowDownToLine, ArrowUpFromLine, X } from "lucide-react";
import { bytes, type Item, type VaultClient } from "@kinic/vault-client";
import { utf8 } from "@kinic/vault-crypto";
import { parseCredential } from "@kinic/vault-crypto/credential";
import { b64 } from "@kinic/vault-crypto/documents";
import {
  exportCredentialsToCsv,
  exportVaultToJson,
  parseImportFile,
  type ExportedVaultItem,
  type ImportFormat,
  type ImportResult,
} from "@kinic/vault-crypto/portability";
import { VaultButton, vaultError } from "./ui";

const FORMAT_LABELS: Record<ImportFormat, string> = {
  "kinic-json": "Kinic Vault JSON",
  "bitwarden-json": "Bitwarden JSON",
  "bitwarden-csv": "Bitwarden CSV",
  "1password-csv": "1Password CSV",
  "safari-csv": "Safari / macOS Passwords CSV",
  "chrome-csv": "Chrome / Edge / Brave CSV",
  "firefox-csv": "Firefox CSV",
  "generic-csv": "Standard CSV",
};

function duplicateKey(kind: string, title: string, username?: string): string {
  return `${kind}|${title.trim().toLocaleLowerCase()}|${(username ?? "").trim().toLocaleLowerCase()}`;
}

function dateStamp(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function VaultPortabilityPanel({
  client,
  items,
  disabled,
  writesDisabled,
  onClose,
  refresh,
}: {
  client: VaultClient;
  items: Item[];
  disabled: boolean;
  writesDisabled: boolean;
  onClose: () => void;
  refresh: () => Promise<void>;
}) {
  const [tab, setTab] = useState<"import" | "export">("import");
  const [parsed, setParsed] = useState<ImportResult>();
  const [parseError, setParseError] = useState("");
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [progress, setProgress] = useState<{ done: number; total: number }>();
  const cancelled = useRef(false);
  const alive = useRef(true);

  useLayoutEffect(() => {
    alive.current = true;
    const detach = client.session.addLockCleanup(() => {
      cancelled.current = true;
      setParsed(undefined);
      setParseError("");
      setStatus("");
      setProgress(undefined);
      setBusy(false);
      onClose();
    });
    return () => {
      alive.current = false;
      cancelled.current = true;
      detach();
    };
  }, [client, onClose]);

  const handleFile = async (file: File | undefined) => {
    setParsed(undefined);
    setParseError("");
    setStatus("");
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      setParseError("Import files are limited to 10 MiB.");
      return;
    }
    try {
      const text = await file.text();
      const result = parseImportFile(text, file.name);
      if (result.items.length === 0) {
        setParseError("No credentials or notes were found in this file.");
        return;
      }
      setParsed(result);
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : "";
      if (code === "EncryptedBitwardenJsonUnsupported") {
        setParseError(
          "Encrypted Bitwarden JSON cannot be read directly. Export an unencrypted JSON or CSV file from Bitwarden, then delete that file after importing.",
        );
      } else {
        setParseError(
          "Could not recognize this file. Supported formats: 1Password CSV, Bitwarden JSON/CSV, Chrome/Safari/Firefox CSV, and Kinic Vault JSON.",
        );
      }
    }
  };

  const existingKeys = new Set(
    items
      .filter((item) => !item.revision.deleted)
      .map((item) =>
        duplicateKey(
          item.metadata.kind,
          item.metadata.title,
          item.metadata.username,
        ),
      ),
  );

  const importCandidates = parsed
    ? skipDuplicates
      ? parsed.items.filter(
          (entry) =>
            !existingKeys.has(
              duplicateKey(
                entry.kind,
                entry.title,
                entry.kind === "credential" ? entry.record.username : undefined,
              ),
            ),
        )
      : parsed.items
    : [];

  const duplicateCount = parsed ? parsed.items.length - importCandidates.length : 0;

  const runImport = async () => {
    if (!parsed || importCandidates.length === 0 || busy || disabled || writesDisabled) {
      return;
    }
    cancelled.current = false;
    setBusy(true);
    setStatus("");
    setProgress({ done: 0, total: importCandidates.length });
    const ticket = client.session.capture();
    let importedCount = 0;
    try {
      for (let i = 0; i < importCandidates.length; i++) {
        if (cancelled.current || !alive.current) break;
        client.session.check(ticket);
        const entry = importCandidates[i];
        const plain = utf8.encode(entry.plaintext);
        try {
          if (plain.length > 256 * 1024) {
            continue;
          }
          await client.save(entry.metadata, plain);
          importedCount++;
        } finally {
          plain.fill(0);
        }
        client.session.check(ticket);
        if (alive.current) {
          setProgress({ done: i + 1, total: importCandidates.length });
        }
      }
      client.session.check(ticket);
      await refresh();
      if (alive.current) {
        setStatus(
          cancelled.current
            ? `Import stopped after ${importedCount} item(s).`
            : `Imported ${importedCount} item(s) into this Vault.`,
        );
        if (!cancelled.current) setParsed(undefined);
      }
    } catch (cause) {
      if (alive.current) {
        setStatus(
          `Imported ${importedCount} item(s) before an error occurred: ${vaultError(cause)}`,
        );
      }
    } finally {
      if (alive.current) {
        setBusy(false);
        setProgress(undefined);
      }
    }
  };

  const runExport = async (mode: "json" | "csv") => {
    if (busy || disabled) return;
    const activeItems = items.filter((item) => !item.revision.deleted);
    const exportTargets = activeItems.filter((item) =>
      mode === "csv"
        ? item.metadata.kind === "credential"
        : item.metadata.kind === "credential" || item.metadata.kind === "note",
    );
    const skippedAttachments = activeItems.filter(
      (item) => item.metadata.kind === "attachment",
    ).length;

    if (exportTargets.length === 0) {
      setStatus(
        mode === "csv"
          ? "No logins to export in this Vault."
          : "No notes or logins to export in this Vault.",
      );
      return;
    }

    cancelled.current = false;
    setBusy(true);
    setStatus("");
    setProgress({ done: 0, total: exportTargets.length });
    const ticket = client.session.capture();
    const exported: ExportedVaultItem[] = [];
    const seen = new Set<string>();

    try {
      for (let i = 0; i < exportTargets.length; i++) {
        if (cancelled.current || !alive.current) break;
        client.session.check(ticket);
        const item = exportTargets[i];
        const objectKey = b64(bytes(item.revision.object));
        if (seen.has(objectKey)) continue;
        seen.add(objectKey);

        const doc = await client.read(item.revision);
        try {
          client.session.check(ticket);
          const text = new TextDecoder().decode(doc.plaintext);
          if (doc.metadata.kind === "credential") {
            exported.push({
              kind: "credential",
              title: doc.metadata.title,
              record: parseCredential(text),
            });
          } else if (doc.metadata.kind === "note") {
            exported.push({
              kind: "note",
              title: doc.metadata.title,
              body: text,
              favorite: doc.metadata.favorite,
              tags: doc.metadata.tags,
            });
          }
        } finally {
          doc.plaintext.fill(0);
        }

        if (alive.current) {
          setProgress({ done: i + 1, total: exportTargets.length });
        }
      }

      if (cancelled.current || !alive.current) {
        if (alive.current) setStatus("Export stopped.");
        return;
      }

      client.session.check(ticket);
      const outputText =
        mode === "json"
          ? exportVaultToJson(exported, skippedAttachments)
          : exportCredentialsToCsv(exported);
      const outputBytes = utf8.encode(outputText);
      try {
        const filename =
          mode === "json"
            ? `kinic-vault-export-${dateStamp()}.json`
            : `kinic-vault-logins-${dateStamp()}.csv`;
        client.session.download(outputBytes, filename);
      } finally {
        outputBytes.fill(0);
      }
      if (alive.current) {
        const extra =
          mode === "json" && skippedAttachments > 0
            ? ` (${skippedAttachments} attachment(s) can be downloaded individually.)`
            : "";
        setStatus(`Exported ${exported.length} item(s).${extra}`);
      }
    } catch (cause) {
      if (alive.current) {
        setStatus(`Export failed: ${vaultError(cause)}`);
      }
    } finally {
      if (alive.current) {
        setBusy(false);
        setProgress(undefined);
      }
    }
  };

  return (
    <div
      className="vault-portability"
      role="region"
      aria-label="Import and export Vault"
    >
      <div className="vault-portability-head">
        <div className="vault-portability-tabs">
          <VaultButton
            size="sm"
            tone={tab === "import" ? "primary" : "ghost"}
            disabled={busy}
            onClick={() => {
              setTab("import");
              setStatus("");
            }}
          >
            <ArrowDownToLine size={14} aria-hidden />
            Import
          </VaultButton>
          <VaultButton
            size="sm"
            tone={tab === "export" ? "primary" : "ghost"}
            disabled={busy}
            onClick={() => {
              setTab("export");
              setStatus("");
            }}
          >
            <ArrowUpFromLine size={14} aria-hidden />
            Export all
          </VaultButton>
        </div>
        <VaultButton
          size="icon"
          tone="ghost"
          aria-label="Close import and export"
          disabled={busy}
          onClick={onClose}
        >
          <X size={16} aria-hidden />
        </VaultButton>
      </div>

      {tab === "import" ? (
        <div className="vault-portability-body">
          <p className="vault-field-hint">
            Import passwords and notes locally in your browser from 1Password
            CSV, Bitwarden JSON/CSV, Chrome, Safari, Firefox, or a Kinic Vault
            JSON export. Everything is encrypted before upload.
          </p>
          <label className="vault-field">
            <span>Select CSV or JSON file</span>
            <input
              type="file"
              accept=".csv,.json,text/csv,application/json"
              className="vault-input"
              disabled={busy || disabled || writesDisabled}
              onChange={(e) => {
                void handleFile(e.target.files?.[0]);
              }}
            />
          </label>
          {parseError ? (
            <p className="vault-notice vault-notice--warn" role="alert">
              {parseError}
            </p>
          ) : null}
          {parsed ? (
            <div className="vault-portability-summary">
              <p>
                Detected <strong>{FORMAT_LABELS[parsed.format]}</strong> ·{" "}
                {parsed.items.length} item(s) found
                {duplicateCount > 0 ? ` (${duplicateCount} duplicate skipped)` : ""}
              </p>
              {parsed.warnings.map((warning) => (
                <p key={warning} className="vault-field-hint">
                  {warning}
                </p>
              ))}
              <label className="vault-generator-check">
                <input
                  type="checkbox"
                  checked={skipDuplicates}
                  disabled={busy}
                  onChange={(e) => setSkipDuplicates(e.target.checked)}
                />
                <span>Skip items with the same title and username</span>
              </label>
              <div className="vault-portability-actions">
                <VaultButton
                  size="sm"
                  tone="primary"
                  disabled={
                    busy ||
                    disabled ||
                    writesDisabled ||
                    importCandidates.length === 0
                  }
                  onClick={() => {
                    void runImport();
                  }}
                >
                  Import {importCandidates.length} item(s)
                </VaultButton>
                {busy ? (
                  <VaultButton
                    size="sm"
                    onClick={() => {
                      cancelled.current = true;
                    }}
                  >
                    Stop
                  </VaultButton>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="vault-portability-body">
          <p className="vault-field-hint">
            Export all logins and notes from this Vault directly in your
            browser. Exported files are unencrypted — store them safely and
            delete temporary copies when finished.
          </p>
          <div className="vault-portability-actions">
            <VaultButton
              size="sm"
              tone="primary"
              disabled={busy || disabled}
              onClick={() => {
                void runExport("json");
              }}
            >
              Export all (JSON)
            </VaultButton>
            <VaultButton
              size="sm"
              disabled={busy || disabled}
              onClick={() => {
                void runExport("csv");
              }}
            >
              Export logins (CSV)
            </VaultButton>
            {busy ? (
              <VaultButton
                size="sm"
                onClick={() => {
                  cancelled.current = true;
                }}
              >
                Stop
              </VaultButton>
            ) : null}
          </div>
        </div>
      )}

      {progress ? (
        <output aria-live="polite" className="vault-field-hint">
          {tab === "import" ? "Importing" : "Exporting"} {progress.done} /{" "}
          {progress.total}…
        </output>
      ) : null}
      {status ? (
        <output aria-live="polite" className="vault-portability-status">
          {status}
        </output>
      ) : null}
    </div>
  );
}
