import { useState, useCallback, useLayoutEffect, useRef } from "react";
import {
  Download,
  FileKey2,
  FileText,
  History,
  Paperclip,
  Plus,
  RefreshCw,
  Save,
  Trash2,
} from "lucide-react";
import { bytes, type Item, type VaultClient } from "@kinic/vault-client";
import { utf8 } from "@kinic/vault-crypto";
import { b64, type Metadata } from "@kinic/vault-crypto/documents";
import type { Revision } from "@kinic/vault-client/contracts";
import { MarkdownEditor } from "@kinic/ui/editor";
import { VaultPreview } from "./preview";
import { VaultButton, VaultField, VaultPanel, vaultError } from "./ui";
import type { VaultWork } from "./workspace";
export function VaultDocuments({
  client,
  items,
  disabled,
  writesDisabled,
  run,
  refresh,
}: {
  client: VaultClient;
  items: Item[];
  disabled: boolean;
  writesDisabled: boolean;
  run: VaultWork;
  refresh: () => Promise<void>;
}) {
  const sensitiveCleanup = useCallback(
    (wipe: () => void) => client.session.addLockCleanup(wipe),
    [client],
  );
  const [query, setQuery] = useState("");
  const search = useRef<AbortController | undefined>(undefined);
  const [bodyMatches, setBodyMatches] = useState<Item[]>();
  const [searchStatus, setSearchStatus] = useState("");
  const [searchProgress, setSearchProgress] = useState<{
    completed: number;
    total: number;
  }>();
  const [saveStatus, setSaveStatus] = useState("");
  const saveNotice = useRef(0);
  const alive = useRef(true);
  const cancelSearch = () => {
    search.current?.abort();
    search.current = undefined;
    setSearchProgress(undefined);
    setBodyMatches(undefined);
  };
  useLayoutEffect(() => {
    alive.current = true;
    const detach = client.session.addLockCleanup(() => {
      cancelSearch();
      setQuery("");
      setSearchStatus("");
      setSaveStatus("");
    });
    return () => {
      alive.current = false;
      search.current?.abort();
      search.current = undefined;
      detach();
    };
  }, [client]);
  const previousItems = useRef(items);
  useLayoutEffect(() => {
    if (previousItems.current === items) return;
    const unchanged =
      previousItems.current.length === items.length &&
      previousItems.current.every((previous, index) => {
        const current = items[index];
        return (
          current &&
          b64(bytes(previous.revision.object)) === b64(bytes(current.revision.object)) &&
          previous.revision.revision === current.revision.revision &&
          previous.revision.deleted === current.revision.deleted
        );
      });
    previousItems.current = items;
    if (!unchanged && (search.current || bodyMatches)) {
      cancelSearch();
      setSearchStatus("Documents refreshed. Search note bodies again.");
    }
  }, [items, bodyMatches]);
  const searchBodies = async () => {
    cancelSearch();
    const controller = new AbortController();
    search.current = controller;
    const ticket = client.session.capture();
    const active = () =>
      alive.current &&
      search.current === controller &&
      !controller.signal.aborted &&
      client.session.capture() === ticket;
    setSearchStatus("");
    try {
      const matches = await client.searchNotes(items, query, {
        signal: controller.signal,
        onProgress: (value) => {
          if (active()) setSearchProgress(value);
        },
      });
      if (!active()) return;
      setBodyMatches(matches);
      setSearchStatus("Note body search complete.");
    } catch (cause) {
      if (active())
        setSearchStatus(`Note body search failed: ${vaultError(cause)}`);
    } finally {
      if (active()) {
        search.current = undefined;
        setSearchProgress(undefined);
      }
    }
  };
  const [current, setCurrent] = useState<Item>();
  const [kind, setKind] = useState<Metadata["kind"]>("note");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [savedBody, setSavedBody] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [url, setUrl] = useState("");
  const [reveal, setReveal] = useState(false);
  const [file, setFile] = useState<File>();
  const [editorKey, setEditorKey] = useState(0);
  const [history, setHistory] = useState<Revision[]>([]);
  const [historyCursor, setHistoryCursor] = useState<bigint>();
  const [progress, setProgress] = useState(0);
  const [dirty, setDirty] = useState(false);
  const reset = () => {
    saveNotice.current++;
    setSaveStatus("");
    setCurrent(undefined);
    setTitle("");
    setBody("");
    setSavedBody("");
    setUsername("");
    setPassword("");
    setUrl("");
    setReveal(false);
    setFile(undefined);
    setHistory([]);
    setHistoryCursor(undefined);
    setProgress(0);
    setDirty(false);
    setEditorKey((k) => k + 1);
  };
  const open = async (item: Item) => {
    const g = client.session.capture();
    if (item.revision.deleted) {
      reset();
      setCurrent(item);
      setTitle(item.metadata.title);
      setKind(item.metadata.kind);
      return;
    }
    const doc = await client.read(item.revision);
    try {
      client.session.check(g);
      reset();
      setCurrent(item);
      setTitle(doc.metadata.title);
      setKind(doc.metadata.kind);
      const text = new TextDecoder().decode(doc.plaintext);
      if (doc.metadata.kind === "credential") {
        const value: Record<string, unknown> = JSON.parse(text);
        setUsername(typeof value.username === "string" ? value.username : "");
        setPassword(typeof value.password === "string" ? value.password : "");
        setUrl(typeof value.URL === "string" ? value.URL : "");
        setBody(typeof value.notes === "string" ? value.notes : "");
      } else if (doc.metadata.kind === "note") {
        setBody(text);
        setSavedBody(text);
      }
    } finally {
      doc.plaintext.fill(0);
    }
  };
  const confirmed = (ticket: number) => {
    client.session.check(ticket);
    reset();
    setSaveStatus("Saved.");
    const notice = saveNotice.current;
    // The committed save is complete. List work must not keep the editor busy
    // or turn a successful save into an ambiguous operation on refresh failure.
    void refresh().catch(() => {
      if (
        alive.current &&
        client.session.capture() === ticket &&
        saveNotice.current === notice
      )
        setSaveStatus(
          "Saved, but the document list could not be refreshed. Refresh documents to update the list.",
        );
    });
  };
  const save = () =>
    run(async () => {
      const g = client.session.capture();
      let plain: Uint8Array;
      let metadata: Metadata = { kind, title };
      if (kind === "attachment") {
        if (!file || file.size > 10 * 1024 * 1024) throw Error("SizeLimit");
        plain = new Uint8Array(await file.arrayBuffer());
        metadata = { ...metadata, filename: file.name, mime: file.type };
      } else {
        plain = utf8.encode(
          kind === "credential"
            ? JSON.stringify({
                label: title,
                username,
                password,
                URL: url,
                notes: body,
              })
            : body,
        );
        if (plain.length > 256 * 1024) {
          plain.fill(0);
          throw Error("SizeLimit");
        }
      }
      try {
        client.session.check(g);
        await client.save(metadata, plain, current, (n) => {
          client.session.check(g);
          setProgress(n);
        });
        client.session.check(g);
        confirmed(g);
      } finally {
        plain.fill(0);
      }
    });
  const download = async (revision: Revision) => {
    const g = client.session.capture();
    const doc = await client.read(revision);
    try {
      client.session.check(g);
      client.session.download(
        doc.plaintext,
        `document-${b64(bytes(revision.object))}-revision-${revision.revision}${doc.metadata.mime === "application/pdf" ? ".pdf" : ".bin"}`,
      );
    } finally {
      doc.plaintext.fill(0);
    }
  };
  const changed = () => {
    saveNotice.current++;
    setDirty(true);
    setSaveStatus("");
  };
  const pendingSave = client.hasPendingSave;
  const readOnly =
    disabled || writesDisabled || pendingSave || !!current?.revision.deleted;
  const byteCount = utf8.encode(body).length;
  return (
    <VaultPanel label="Private documents" sensitive className="vault-documents">
      <div className="vault-documents-header flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <FileText size={18} aria-hidden />
          <h2 className="font-semibold">Private documents</h2>
          <span className="vault-count">{items.length}</span>
        </div>
        <VaultField
          label="Search this Vault locally"
          labelHidden
          type="search"
          placeholder="Find a private document…"
          value={query}
          onChange={(e) => {
            cancelSearch();
            setSearchStatus("");
            setQuery(e.target.value);
          }}
        />
        <VaultButton disabled={disabled} onClick={() => run(refresh)}>
          <RefreshCw size={15} aria-hidden />
          Refresh documents
        </VaultButton>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <VaultButton
          disabled={disabled || !query.trim() || !!searchProgress}
          onClick={() => void searchBodies()}
        >
          Search note bodies
        </VaultButton>
        <span className="text-sm text-muted">
          Titles filter immediately. Body search reads notes only.
        </span>
        {searchProgress ? (
          <>
            <output aria-live="polite">
              Searching note bodies: {searchProgress.completed} /{" "}
              {searchProgress.total}
            </output>
            <VaultButton
              onClick={() => {
                cancelSearch();
                setSearchStatus("Note body search stopped.");
              }}
            >
              Stop search
            </VaultButton>
          </>
        ) : null}
        {searchStatus ? (
          <output aria-live="polite">{searchStatus}</output>
        ) : null}
      </div>
      {saveStatus ? <output aria-live="polite">{saveStatus}</output> : null}
      {pendingSave ? (
        <div className="grid gap-2 rounded-lg border border-line p-3">
          <output>
            {disabled
              ? "An encrypted save is in progress."
              : "The encrypted save is paused. Resume this save, or cancel its unfinished upload before editing. Closing this Vault discards the local save job."}
          </output>
          <div className="flex flex-wrap gap-2">
            <VaultButton
              disabled={disabled || writesDisabled}
              onClick={() =>
                run(async () => {
                  const ticket = client.session.capture();
                  await client.resumeSave((n) => {
                    client.session.check(ticket);
                    setProgress(n);
                  });
                  client.session.check(ticket);
                  confirmed(ticket);
                })
              }
            >
              Resume save
            </VaultButton>
            <VaultButton
              disabled={disabled}
              onClick={() =>
                run(async () => {
                  const ticket = client.session.capture();
                  const result = await client.cancelSave();
                  client.session.check(ticket);
                  if ("Committed" in result) confirmed(ticket);
                  else {
                    setProgress(0);
                    await refresh();
                  }
                })
              }
            >
              Cancel save
            </VaultButton>
          </div>
        </div>
      ) : null}
      <div className="vault-document-grid">
        <div className="vault-document-list grid min-w-0 content-start gap-2">
          <VaultButton disabled={disabled || pendingSave} onClick={reset}>
            <Plus size={16} aria-hidden />
            New document
          </VaultButton>
          {items
            .filter(
              (item) =>
                item.metadata.title
                  .toLocaleLowerCase()
                  .includes(query.toLocaleLowerCase()) ||
                bodyMatches?.some(
                  (match) =>
                    b64(bytes(match.revision.object)) ===
                    b64(bytes(item.revision.object)),
                ),
            )
            .map((item) => (
              <VaultButton
                key={b64(bytes(item.revision.object))}
                disabled={disabled || pendingSave}
                aria-pressed={
                  !!current &&
                  b64(bytes(current.revision.object)) ===
                    b64(bytes(item.revision.object))
                }
                onClick={() => run(() => open(item))}
                className="vault-document-item"
              >
                {item.metadata.kind === "credential" ? (
                  <FileKey2 size={17} aria-hidden />
                ) : item.metadata.kind === "attachment" ? (
                  <Paperclip size={17} aria-hidden />
                ) : (
                  <FileText size={17} aria-hidden />
                )}
                <span>
                  {item.metadata.title || "Untitled"}
                  {item.revision.deleted ? " (deleted)" : ""}
                </span>
              </VaultButton>
            ))}
          {!items.length ? (
            <p className="text-sm text-muted">
              No documents yet. Create a note, credential or attachment.
            </p>
          ) : null}
        </div>
        <div className="vault-document-editor grid min-w-0 content-start gap-3">
          <VaultField
            label="Document title"
            labelHidden
            value={title}
            maxLength={512}
            disabled={readOnly}
            onChange={(e) => {
              setTitle(e.target.value);
              changed();
            }}
          />
          <label className="grid gap-1 text-sm font-medium">
            <span className="sr-only">Document type</span>
            <select
              className="min-h-10 rounded-lg border border-line bg-white px-3 text-ink"
              value={kind}
              disabled={readOnly || !!current}
              onChange={(e) => {
                setKind(e.target.value as Metadata["kind"]);
                changed();
              }}
            >
              <option value="note">Note</option>
              <option value="credential">Credential</option>
              <option value="attachment">Attachment</option>
            </select>
          </label>
          {!current?.revision.deleted ? (
            <>
              {kind === "note" ? (
                <>
                  <div className="h-80 min-w-0 overflow-hidden rounded-lg border border-line focus-within:ring-2 focus-within:ring-accent focus-within:ring-offset-2">
                    <MarkdownEditor
                      key={editorKey}
                      content={body}
                      indentWithTab={false}
                      sensitiveCleanup={sensitiveCleanup}
                      disabled={readOnly}
                      lineCount={body.split("\n").length}
                      byteCount={byteCount}
                      saveState={disabled ? "saving" : dirty ? "dirty" : "idle"}
                      error={null}
                      warning={
                        byteCount > 256 * 1024
                          ? "Notes are limited to 256 KiB."
                          : null
                      }
                      onChange={(value) => {
                        setBody(value);
                        changed();
                      }}
                      onRevert={() => {
                        setTitle(current?.metadata.title ?? "");
                        setBody(savedBody);
                        setDirty(false);
                        setEditorKey((k) => k + 1);
                      }}
                      onSave={save}
                    />
                  </div>
                  <details className="[&:not([open])>div]:hidden">
                    <summary className="cursor-pointer text-sm font-medium">
                      Private Markdown preview
                    </summary>
                    <div className="mt-3 rounded-lg border border-line p-3">
                      <VaultPreview content={body} />
                    </div>
                  </details>
                </>
              ) : kind === "credential" ? (
                <>
                  <VaultField
                    label="Username"
                    value={username}
                    disabled={readOnly}
                    onChange={(e) => {
                      setUsername(e.target.value);
                      changed();
                    }}
                  />
                  <VaultField
                    label="Password"
                    type={reveal ? "text" : "password"}
                    value={password}
                    disabled={readOnly}
                    onChange={(e) => {
                      setPassword(e.target.value);
                      changed();
                    }}
                  />
                  <VaultButton
                    aria-pressed={reveal}
                    disabled={disabled}
                    onClick={() => setReveal(!reveal)}
                  >
                    {reveal ? "Hide password" : "Show password"}
                  </VaultButton>
                  <VaultButton
                    disabled={disabled}
                    onClick={() =>
                      run(async () => {
                        await navigator.clipboard.writeText(password);
                      })
                    }
                  >
                    Copy password
                  </VaultButton>
                  <p className="text-sm text-muted">
                    The clipboard is not cleared automatically.
                  </p>
                  <VaultField
                    label="URL (stored as text)"
                    value={url}
                    disabled={readOnly}
                    onChange={(e) => {
                      setUrl(e.target.value);
                      changed();
                    }}
                  />
                  <label className="grid gap-1 text-sm font-medium">
                    Credential notes
                    <textarea
                      className="min-h-32 rounded-lg border border-line bg-white p-3 text-ink"
                      value={body}
                      disabled={readOnly}
                      onChange={(e) => {
                        setBody(e.target.value);
                        changed();
                      }}
                    />
                  </label>
                </>
              ) : (
                <VaultField
                  key={`file-${editorKey}`}
                  label="Attachment (10 MiB maximum)"
                  type="file"
                  disabled={readOnly}
                  onChange={(e) => {
                    setFile(e.target.files?.[0]);
                    changed();
                  }}
                />
              )}
              <VaultButton
                tone="primary"
                disabled={
                  readOnly || !dirty || (kind === "attachment" && !file)
                }
                onClick={save}
              >
                <Save size={16} aria-hidden />
                Save document
              </VaultButton>
              {progress > 0 ? (
                <output className="text-sm">Upload {progress}%</output>
              ) : null}
            </>
          ) : (
            <p className="text-sm text-muted">
              This document is deleted. Historical versions remain available
              until permanent deletion.
            </p>
          )}
          {current ? (
            <div className="grid gap-3 border-t border-line pt-3">
              <div className="flex flex-wrap gap-2">
                <VaultButton
                  disabled={disabled}
                  onClick={() =>
                    run(async () => {
                      const g = client.session.capture();
                      const page = await client.history(current.revision);
                      client.session.check(g);
                      setHistory(page.entries);
                      setHistoryCursor(page.next[0]);
                    })
                  }
                >
                  <History size={15} aria-hidden />
                  Show version history
                </VaultButton>
                {!current.revision.deleted ? (
                  <>
                    <VaultButton
                      disabled={disabled}
                      onClick={() => run(() => download(current.revision))}
                    >
                      <Download size={15} aria-hidden />
                      Download document
                    </VaultButton>
                    <VaultButton
                      disabled={disabled || writesDisabled || pendingSave}
                      onClick={() =>
                        run(async () => {
                          const g = client.session.capture();
                          await client.deleteObject(current.revision);
                          client.session.check(g);
                          reset();
                          await refresh();
                        })
                      }
                    >
                      <Trash2 size={15} aria-hidden />
                      Delete document
                    </VaultButton>
                  </>
                ) : null}
                <VaultButton
                  disabled={disabled || pendingSave}
                  onClick={() => {
                    if (
                      !window.confirm(
                        "Permanently delete this document and its history? This cannot be undone.",
                      )
                    )
                      return;
                    run(async () => {
                      const g = client.session.capture();
                      await client.purgeObject(current.revision);
                      client.session.check(g);
                      reset();
                      await refresh();
                    });
                  }}
                >
                  Permanently delete document and history
                </VaultButton>
              </div>
              {history.length ? (
                <div className="grid gap-2">
                  <h3 className="font-medium">Version history</h3>
                  {historyCursor !== undefined ? (
                    <VaultButton
                      disabled={disabled}
                      onClick={() =>
                        run(async () => {
                          const g = client.session.capture(),
                            page = await client.history(
                              current.revision,
                              historyCursor,
                            );
                          client.session.check(g);
                          setHistory((previous) => [
                            ...previous,
                            ...page.entries,
                          ]);
                          setHistoryCursor(page.next[0]);
                        })
                      }
                    >
                      Load more history
                    </VaultButton>
                  ) : null}
                  {history.map((revision) => (
                    <div
                      className="flex flex-wrap items-center justify-between gap-2 text-sm"
                      key={String(revision.revision)}
                    >
                      <span>
                        Revision {String(revision.revision)}
                        {revision.deleted ? " (deleted)" : ""}
                      </span>
                      {!revision.deleted ? (
                        <VaultButton
                          disabled={disabled}
                          onClick={() => run(() => download(revision))}
                        >
                          Download revision {String(revision.revision)}
                        </VaultButton>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </VaultPanel>
  );
}
