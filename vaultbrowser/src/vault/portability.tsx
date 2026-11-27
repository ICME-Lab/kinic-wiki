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
  run,
  onPendingSaveChange,
}: {
  client: VaultClient;
  items: Item[];
  disabled: boolean;
  writesDisabled: boolean;
  onClose: () => void;
  refresh: () => Promise<void>;
  run?: (work: () => Promise<void>) => void;
  onPendingSaveChange?: (pending: boolean) => void;
}) {
  const [tab, setTab] = useState<"import" | "export">("import");
  const [parsed, setParsed] = useState<ImportResult>();
  const [parseError, setParseError] = useState("");
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [progress, setProgress] = useState<{ done: number; total: number }>();
  const [outcomes, setOutcomes] = useState<Record<number, "saved" | "oversized">>({});
  const [pendingIndex, setPendingIndex] = useState<number>();
  const callbacks = useRef({ onClose, onPendingSaveChange });
  useLayoutEffect(() => { callbacks.current = { onClose, onPendingSaveChange }; });
  const fileEpoch = useRef<object>({});
  const working = useRef(false);
  const start = (work: () => Promise<void>) => { if (run) run(work); else void work(); };
  const cancelled = useRef(false);
  const alive = useRef(true);

  useLayoutEffect(() => {
    alive.current = true;
    const detach = client.session.addLockCleanup(() => {
      cancelled.current = true;
      fileEpoch.current = {};
      working.current = false;
      setOutcomes({});
      setPendingIndex(undefined);
      callbacks.current.onPendingSaveChange?.(false);
      setParsed(undefined);
      setParseError("");
      setStatus("");
      setProgress(undefined);
      setBusy(false);
      callbacks.current.onClose();
    });
    return () => {
      fileEpoch.current = {};
      alive.current = false;
      cancelled.current = true;
      detach();
    };
  }, [client]);

  const handleFile = async (file: File | undefined) => {
    if (working.current || pendingIndex !== undefined) return;
    const epoch = {};
    fileEpoch.current = epoch;
    const ticket = client.session.capture();
    const current = () => alive.current && epoch === fileEpoch.current && ticket === client.session.capture();
    setOutcomes({});
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
      if (!current()) return;
      const result = parseImportFile(text, file.name);
      if (result.items.length === 0) {
        setParseError("No credentials or notes were found in this file.");
        return;
      }
      setParsed(result);
    } catch (cause) {
      if (!current()) return;
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

  const indexed = (parsed?.items ?? []).map((entry, index) => ({ entry, index }));
  const duplicate = (entry: ImportResult["items"][number]) => skipDuplicates && existingKeys.has(
    duplicateKey(entry.kind, entry.title, entry.kind === "credential" ? entry.record.username : undefined),
  );
  const importCandidates = indexed.filter(({ entry, index }) => !outcomes[index] && !duplicate(entry));
  const duplicateCount = indexed.filter(({ entry, index }) => !outcomes[index] && duplicate(entry)).length;
  const oversizedCount = Object.values(outcomes).filter(value => value === "oversized").length;
  const pending = pendingIndex !== undefined;

  const runImport = async () => {
    if (!parsed || !importCandidates.length || working.current || disabled || writesDisabled || client.hasPendingSave) return;
    working.current = true;
    cancelled.current = false;
    setBusy(true);
    setStatus("");
    setProgress({ done: 0, total: importCandidates.length });
    const ticket = client.session.capture();
    const current = () => alive.current && client.session.capture() === ticket;
    let importedCount = 0;
    let activeIndex: number | undefined;
    const next = { ...outcomes };
    try {
      for (let i = 0; i < importCandidates.length; i++) {
        if (cancelled.current || !current()) break;
        client.session.check(ticket);
        const { entry, index } = importCandidates[i];
        activeIndex = index;
        const plain = utf8.encode(entry.plaintext);
        try {
          if (plain.length > 256 * 1024) {
            next[index] = "oversized";
          } else {
            await client.save(entry.metadata, plain);
            client.session.check(ticket);
            next[index] = "saved";
            importedCount++;
          }
        } finally { plain.fill(0); }
        if (!current()) return;
        setOutcomes({ ...next });
        setProgress({ done: i + 1, total: importCandidates.length });
      }
      if (!current()) return;
      const oversized = Object.values(next).filter(value => value === "oversized").length;
      setStatus(cancelled.current ? `Import stopped after ${importedCount} item(s).` : `Imported ${importedCount} item(s) into this Vault.`);
      if (!cancelled.current && oversized === 0) setParsed(undefined);
    } catch (cause) {
      if (!current()) return;
      if (client.hasPendingSave && activeIndex !== undefined) {
        setPendingIndex(activeIndex);
        callbacks.current.onPendingSaveChange?.(true);
      }
      setStatus(`Imported ${importedCount} item(s) before an error occurred: ${vaultError(cause)}`);
    } finally {
      if (current()) {
        try { await refresh(); } catch { /* Keep confirmed outcomes for safe retry. */ }
        if (current()) { working.current = false; setBusy(false); setProgress(undefined); }
      }
    }
  };

  const resolveImport = async (cancel: boolean) => {
    if (pendingIndex === undefined || working.current || disabled) return;
    working.current = true;
    setBusy(true);
    const ticket = client.session.capture();
    const index = pendingIndex;
    try {
      const committed = cancel ? "Committed" in await client.cancelSave() : !!await client.resumeSave();
      client.session.check(ticket);
      if (!alive.current) return;
      if (committed) setOutcomes(previous => ({ ...previous, [index]: "saved" }));
      setPendingIndex(undefined);
      callbacks.current.onPendingSaveChange?.(false);
      setStatus(committed ? "Import save confirmed. Continue with the remaining items." : "Unfinished import save cancelled. Remaining items can be retried.");
      try { await refresh(); } catch { /* Confirmed outcomes survive list-refresh errors. */ }
    } catch (cause) {
      if (alive.current && client.session.capture() === ticket) {
        if (!client.hasPendingSave) {
          setPendingIndex(undefined);
          callbacks.current.onPendingSaveChange?.(false);
        }
        setStatus(`Could not resolve import save: ${vaultError(cause)}`);
      }
    } finally {
      if (alive.current && client.session.capture() === ticket) { working.current = false; setBusy(false); }
    }
  };

  const runExport = async (mode: "json" | "csv") => {
    if (busy || disabled || pending) return;
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
    <section
      className="vault-portability"
      aria-label="Import and export Vault"
    >
      <div className="vault-portability-head">
        <div className="vault-portability-tabs">
          <VaultButton
            size="sm"
            tone={tab === "import" ? "primary" : "ghost"}
            disabled={busy || pending}
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
            disabled={busy || pending}
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
          disabled={busy || pending}
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
              disabled={busy || pending || disabled || writesDisabled}
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
              {oversizedCount > 0 ? <div role="alert">
                <p>{oversizedCount} item(s) exceed the 256 KiB limit and were not imported. Keep your source file.</p>
                <ul aria-label="Import item results">{indexed.filter(({ index }) => outcomes[index] === "oversized").map(({ entry, index }) => <li key={index}>{entry.title}: exceeds 256 KiB</li>)}</ul>
              </div> : null}
              {pending ? <div>
                <output>A save result is unknown. Resolve it before importing more items.</output>
                <VaultButton disabled={busy || disabled} onClick={() => start(() => resolveImport(false))}>Resolve import save</VaultButton>
                <VaultButton disabled={busy || disabled} onClick={() => start(() => resolveImport(true))}>Cancel unfinished import save</VaultButton>
              </div> : null}
              {parsed.warnings.map((warning) => (
                <p key={warning} className="vault-field-hint">
                  {warning}
                </p>
              ))}
              <label className="vault-generator-check">
                <input
                  type="checkbox"
                  checked={skipDuplicates}
                  disabled={busy || pending}
                  onChange={(e) => setSkipDuplicates(e.target.checked)}
                />
                <span>Skip items with the same title and username</span>
              </label>
              <div className="vault-portability-actions">
                <VaultButton
                  size="sm"
                  tone="primary"
                  disabled={
                    busy || pending ||
                    disabled ||
                    writesDisabled ||
                    importCandidates.length === 0
                  }
                  onClick={() => {
                    start(runImport);
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
            delete temporary copies when finished. CSV saves one row per login.
          Use JSON to keep logins grouped with their Vault item.
          </p>
          <div className="vault-portability-actions">
            <VaultButton
              size="sm"
              tone="primary"
              disabled={busy || disabled}
              onClick={() => {
                start(() => runExport("json"));
              }}
            >
              Export all (JSON)
            </VaultButton>
            <VaultButton
              size="sm"
              disabled={busy || disabled}
              onClick={() => {
                start(() => runExport("csv"));
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
    </section>
  );
}
