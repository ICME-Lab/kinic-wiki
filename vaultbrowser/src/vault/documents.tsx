import { useState, useCallback, useLayoutEffect, useRef } from "react";
import {
  ChevronRight,
  Download,
  Eye,
  EyeOff,
  FileKey2,
  FileText,
  History,
  Paperclip,
  Plus,
  RefreshCw,
  Save,
  Search,
  TextSearch,
  Upload,
} from "lucide-react";
import { bytes, type Item, type VaultClient } from "@kinic/vault-client";
import { utf8 } from "@kinic/vault-crypto";
import { b64, type Metadata } from "@kinic/vault-crypto/documents";
import type { Revision } from "@kinic/vault-client/contracts";
import { MarkdownEditor } from "@kinic/ui/editor";
import {CopyPasswordButton} from "../copy-button";
import { VaultPreview } from "./preview";
import { DocumentActions } from "./document-actions";
import { DraftGuardProvider, useDirtyDraft, useDraftGuard } from "../draft-guard";
import { VaultButton, VaultField, VaultPanel, vaultError } from "./ui";
import type { VaultWork } from "./workspace";
function Documents({
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
  const [viewedRevision, setViewedRevision] = useState<Revision>();
  const [viewedMetadata, setViewedMetadata] = useState<Metadata>();
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
  const guard = useDraftGuard();
  useDirtyDraft(dirty, client);
  const editorEpoch=useRef(0);
  const reset = () => {
    editorEpoch.current++;
    saveNotice.current++;
    setSaveStatus("");
    setCurrent(undefined);
    setViewedRevision(undefined);
    setViewedMetadata(undefined);
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
  const open = async (item: Item, revision: Revision = item.revision) => {
    const g = client.session.capture();
    const epoch = editorEpoch.current;
    const sameDocument = current && b64(bytes(current.revision.object)) === b64(bytes(item.revision.object));
    const retainedHistory = sameDocument ? history : [];
    const retainedCursor = sameDocument ? historyCursor : undefined;
    if (revision.deleted) {
      reset();
      setCurrent(item);
      setTitle(item.metadata.title);
      setKind(item.metadata.kind);
      return;
    }
    const doc = await client.read(revision);
    try {
      client.session.check(g);
      if (editorEpoch.current !== epoch) return;
      reset();
      setCurrent(item);
      setViewedRevision(revision);
      setViewedMetadata(doc.metadata);
      setHistory(retainedHistory);
      setHistoryCursor(retainedCursor);
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
  const completeSave = (
    revision: Revision,
    metadata: Metadata = {
      ...current?.metadata,
      kind,
      title,
      ...(file ? { filename: file.name, mime: file.type } : {}),
    },
  ) => {
    editorEpoch.current++;
    setCurrent({ revision, metadata });
    setViewedRevision(undefined);
    setViewedMetadata(metadata);
    setSavedBody(body);
    setDirty(false);
    setProgress(0);
    setHistory([]);
    setHistoryCursor(undefined);
  };
  const confirmed = (ticket: number, revision?: Revision, metadata?: Metadata) => {
    client.session.check(ticket);
    if (revision) completeSave(revision, metadata);
    else reset();
    saveNotice.current++;
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
        const revision = await client.save(metadata, plain, current, (n) => {
          client.session.check(g);
          setProgress(n);
        });
        client.session.check(g);
        confirmed(g, revision, metadata);
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
  const displayedRevision = viewedRevision ?? current?.revision;
  const historical = !!current && !!viewedRevision && viewedRevision.revision !== current.revision.revision;
  const readOnly =
    disabled || writesDisabled || pendingSave || !!displayedRevision?.deleted || historical;
  const byteCount = utf8.encode(body).length;
  const kindLabel = (k: Metadata["kind"]) =>
    k === "credential" ? "Credential" : k === "attachment" ? "Attachment" : "Note";
  const visibleItems = items.filter(
    (item) =>
      item.metadata.title
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase()) ||
      bodyMatches?.some(match => b64(bytes(match.revision.object)) === b64(bytes(item.revision.object))),
  );
  return (
    <VaultPanel label="Private documents" sensitive className="vault-documents">
      <div className="vault-documents-header">
        <div className="vault-documents-title">
          <h2>Private documents</h2>
          <span className="vault-count">{items.length}</span>
        </div>
        <div className="vault-documents-tools">
          <VaultButton
            tone="ghost"
            size="icon"
            aria-label="Refresh documents"
            title="Refresh documents"
            disabled={disabled}
            onClick={() => run(refresh)}
          >
            <RefreshCw size={16} aria-hidden />
          </VaultButton>
          <VaultButton
            tone="primary"
            className="vault-new-document"
            title="New document"
            disabled={disabled || pendingSave}
            onClick={() => guard.protect(reset)}
          >
            <Plus size={16} aria-hidden />
            New document
          </VaultButton>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
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
        <div className="vault-notice vault-notice--warn vault-pending-save">
          <output>
            {disabled
              ? "An encrypted save is in progress."
              : "The encrypted save is paused. Resume this save, or cancel its unfinished upload before editing. Closing this Vault discards the local save job."}
          </output>
          <div>
            <VaultButton
              size="sm"
              tone="primary"
              disabled={disabled || writesDisabled}
              onClick={() =>
                run(async () => {
                  const ticket = client.session.capture();
                  const revision = await client.resumeSave((n) => {
                    client.session.check(ticket);
                    setProgress(n);
                  });
                  client.session.check(ticket);
                  confirmed(ticket, revision);
                })
              }
            >
              Resume save
            </VaultButton>
            <VaultButton
              size="sm"
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
        <div className="vault-document-list">
          <div className="vault-search">
            <div className="vault-search-input">
              <Search size={15} aria-hidden />
              <VaultField
                label="Search this Vault locally"
                labelHidden
                type="search"
                placeholder="Search titles…"
                value={query}
                disabled={disabled}
                onChange={(e) => { cancelSearch(); setSearchStatus(""); setQuery(e.target.value); }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void searchBodies();
                }}
              />
            </div>
            <VaultButton
              tone="ghost"
              className={query.trim() ? undefined : "vault-search-idle"}
              disabled={disabled || !!searchProgress || !query.trim()}
              onClick={() => void searchBodies()}
            >
              <TextSearch size={14} aria-hidden />
              Search note contents
            </VaultButton>
          </div>
          <div className="vault-document-items">
            {visibleItems.map((item) => (
              <div className="vault-document-card" key={b64(bytes(item.revision.object))}>
              <VaultButton
                disabled={disabled || pendingSave}
                aria-pressed={
                  !!current &&
                  b64(bytes(current.revision.object)) ===
                    b64(bytes(item.revision.object))
                }
                onClick={() => guard.protect(() => run(() => open(item)))}
                className="vault-document-item"
              >
                <span className="vault-document-icon" aria-hidden>
                  {item.metadata.kind === "credential" ? (
                    <FileKey2 size={16} />
                  ) : item.metadata.kind === "attachment" ? (
                    <Paperclip size={16} />
                  ) : (
                    <FileText size={16} />
                  )}
                </span>
                <span className="vault-document-text">
                  <span>
                    {item.metadata.title || "Untitled"}
                    {item.revision.deleted ? " (deleted)" : ""}
                  </span>
                  <span aria-hidden>{kindLabel(item.metadata.kind)}</span>
                </span>
              </VaultButton>
              <DocumentActions
                key={String(item.revision.revision)}
                item={item}
                client={client}
                disabled={disabled || pendingSave}
                writesDisabled={writesDisabled}
                onDelete={(target, permanent) => run(async () => {
                  const ticket = client.session.capture();
                  const epoch = editorEpoch.current;
                  if (permanent) await client.purgeObject(target.revision);
                  else await client.deleteObject(target.revision);
                  client.session.check(ticket);
                  if (current && b64(bytes(current.revision.object)) === b64(bytes(target.revision.object)) && editorEpoch.current === epoch) reset();
                  await refresh();
                })}
              />
              </div>
            ))}
            {!items.length ? (
              <p className="vault-document-empty">
                No documents yet. Create a note, credential or attachment.
              </p>
            ) : !visibleItems.length ? (
              <p className="vault-document-empty">
                No titles match. Use Search note contents to look inside notes.
              </p>
            ) : null}
          </div>
        </div>
        <div className="vault-document-editor">
          {historical ? (
            <div className="vault-notice" aria-label="Historical version">
              <span>Viewing revision {String(viewedRevision!.revision)} · Read-only</span>
              <VaultButton size="sm" disabled={disabled || pendingSave} onClick={() => guard.protect(() => run(() => open(current!)))}>
                Return to latest version
              </VaultButton>
            </div>
          ) : null}
          <div className="vault-editor-head">
            <VaultField
              fieldClassName="vault-editor-title"
              label="Document title"
              labelHidden
              placeholder="Untitled"
              value={title}
              maxLength={512}
              disabled={readOnly}
              onChange={(e) => {
                setTitle(e.target.value);
                changed();
              }}
            />
            <label className="vault-field vault-editor-kind">
              <span className="sr-only">Document type</span>
              <select
                className="vault-select"
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
            {!displayedRevision?.deleted ? (
              <VaultButton
                tone="primary"
                className="vault-editor-save"
                disabled={
                  readOnly || !dirty || (kind === "attachment" && !file)
                }
                onClick={save}
              >
                <Save size={15} aria-hidden />
                Save document
              </VaultButton>
            ) : null}
          </div>
          <div className="vault-editor-body">
            {!displayedRevision?.deleted ? (
              kind === "note" ? (
                <>
                  <div className="vault-editor-frame">
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
                  <details className="vault-preview">
                    <summary>
                      <ChevronRight size={14} aria-hidden />
                      Private Markdown preview
                    </summary>
                    <div>
                      <VaultPreview content={body} />
                    </div>
                  </details>
                </>
              ) : kind === "credential" ? (
                <div className="vault-credential">
                  <VaultField
                    label="Username"
                    value={username}
                    disabled={readOnly}
                    onChange={(e) => {
                      setUsername(e.target.value);
                      changed();
                    }}
                  />
                  <div className="vault-password">
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
                    <div className="vault-password-actions">
                      <VaultButton
                        size="sm"
                        aria-pressed={reveal}
                        disabled={disabled}
                        onClick={() => setReveal(!reveal)}
                      >
                        {reveal ? (
                          <EyeOff size={14} aria-hidden />
                        ) : (
                          <Eye size={14} aria-hidden />
                        )}
                        {reveal ? "Hide password" : "Show password"}
                      </VaultButton>
                      <CopyPasswordButton key={editorKey} value={password} disabled={disabled}/>
                    </div>
                    <p className="vault-field-hint">
                      The clipboard is not cleared automatically.
                    </p>
                  </div>
                  <VaultField
                    fieldClassName="vault-credential-wide"
                    label="URL (stored as text)"
                    value={url}
                    disabled={readOnly}
                    onChange={(e) => {
                      setUrl(e.target.value);
                      changed();
                    }}
                  />
                  <label className="vault-field vault-credential-wide">
                    <span>Credential notes</span>
                    <textarea
                      className="vault-textarea"
                      value={body}
                      disabled={readOnly}
                      onChange={(e) => {
                        setBody(e.target.value);
                        changed();
                      }}
                    />
                  </label>
                </div>
              ) : (
                <div className="vault-attachment">
                  <Upload size={26} aria-hidden />
                  {viewedMetadata?.filename ? <p>{viewedMetadata.filename}</p> : null}
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
                </div>
              )
            ) : (
              <p className="vault-notice vault-deleted-note">
                This document is deleted. Historical versions remain available
                until permanent deletion.
              </p>
            )}
            {current && history.length ? (
              <div className="vault-history">
                <h3>Version history</h3>
                {history.map((revision) => (
                  <div
                    className="vault-history-row"
                    key={String(revision.revision)}
                  >
                    <span>
                      Revision {String(revision.revision)}
                      {revision.deleted ? " (deleted)" : ""}
                    </span>
                    {!revision.deleted ? (
                      <VaultButton
                        size="sm"
                        disabled={disabled || pendingSave}
                        aria-pressed={displayedRevision?.revision === revision.revision}
                        onClick={() => guard.protect(() => run(() => open(current, revision)))}
                      >
                        <Eye size={14} aria-hidden />
                        View revision {String(revision.revision)}
                      </VaultButton>
                    ) : null}
                  </div>
                ))}
                {historyCursor !== undefined ? (
                  <VaultButton
                    size="sm"
                    tone="ghost"
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
              </div>
            ) : null}
          </div>
          <div
            className="vault-editor-footer"
            hidden={!current && progress === 0}
          >
            {current ? (
              <div className="vault-editor-footer-actions">
                <VaultButton
                  size="sm"
                  tone="ghost"
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
                  <History size={14} aria-hidden />
                  Show version history
                </VaultButton>
                {!displayedRevision?.deleted ? (
                  <>
                    <VaultButton
                      size="sm"
                      tone="ghost"
                      disabled={disabled}
                      onClick={() => run(() => download(displayedRevision!))}
                    >
                      <Download size={14} aria-hidden />
                      Download document
                    </VaultButton>
                  </>
                ) : null}

              </div>
            ) : null}
            {progress > 0 ? (
              <output className="vault-editor-progress">
                Upload {progress}%
              </output>
            ) : null}
          </div>
        </div>
      </div>
    </VaultPanel>
  );
}

export function VaultDocuments(props:Parameters<typeof Documents>[0]){return <DraftGuardProvider><Documents {...props}/></DraftGuardProvider>;}
