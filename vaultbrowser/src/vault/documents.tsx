import { useState, useCallback, useLayoutEffect, useRef } from "react";
import {
  Check,
  Download,
  Eye,
  FileKey2,
  FileText,
  History,
  LoaderCircle,
  Paperclip,
  Plus,
  Save,
  Upload,
} from "lucide-react";
import { bytes, type Item, type VaultClient } from "@kinic/vault-client";
import { utf8 } from "@kinic/vault-crypto";
import { b64, type Metadata } from "@kinic/vault-crypto/documents";
import type { Revision } from "@kinic/vault-client/contracts";
import { MarkdownEditor } from "@kinic/ui/editor";
import { credentialProblem, emptyLogin, isBlankLogin, parseCredential, serializeCredential, type CredentialLogin } from "./credential";
import { CredentialLoginFields } from "./credential-login-fields";
import { VaultPreview } from "./preview";
import { VaultReadOnly } from "./read-only";
import { DocumentActions } from "./document-actions";
import { DraftGuardProvider, useDirtyDraft, useDraftGuard } from "../draft-guard";
import { VaultButton, VaultField, VaultPanel } from "./ui";
import type { VaultWork } from "./workspace";
function Documents({
  client,
  items,
  disabled,
  writesDisabled,
  canEdit = true,
  canPurge = true,
  run,
  onCommitted,
  refresh,
}: {
  client: VaultClient;
  items: Item[];
  disabled: boolean;
  writesDisabled: boolean;
  canEdit?: boolean;
  canPurge?: boolean;
  run: VaultWork;
  onCommitted: (item: Item) => void;
  refresh: () => Promise<void>;
}) {
  const sensitiveCleanup = useCallback(
    (wipe: () => void) => client.session.addLockCleanup(wipe),
    [client],
  );
  const [saving, setSaving] = useState(false);
  const [noteView, setNoteView] = useState<"edit" | "preview">("edit");
  const titleInput = useRef<HTMLInputElement>(null);
  const [saveStatus, setSaveStatus] = useState<"saved" | "renamed">();
  const pendingRename = useRef<Item | undefined>(undefined);
  useLayoutEffect(() => {
    const detach = client.session.addLockCleanup(() => {
      setSaving(false);
      setNoteView("edit");
      setSaveStatus(undefined);
      pendingRename.current = undefined;
    });
    return () => { detach(); };
  }, [client]);
  const [current, setCurrent] = useState<Item>();
  const [viewedRevision, setViewedRevision] = useState<Revision>();
  const historical = !!current && !!viewedRevision && viewedRevision.revision !== current.revision.revision;
  const [viewedMetadata, setViewedMetadata] = useState<Metadata>();
  const [kind, setKind] = useState<Metadata["kind"]>("note");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [savedBody, setSavedBody] = useState("");
  const nextLoginId = useRef(1);
  const addLoginButton = useRef<HTMLButtonElement>(null);
  const [logins, setLogins] = useState<(CredentialLogin & { id: number; focusUsername?: boolean })[]>([{ ...emptyLogin, id: 0 }]);
  // Focus moves to Add login after the confirm dialog has closed and returned focus.
  const focusAddLogin = useRef(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const notesInput = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    if (!focusAddLogin.current) return;
    focusAddLogin.current = false;
    addLoginButton.current?.focus();
  }, [logins]);
  const [file, setFile] = useState<File>();
  const [editorKey, setEditorKey] = useState(0);
  const [history, setHistory] = useState<{
    entries: Revision[];
    cursor?: bigint;
    visible: boolean;
  }>();
  const historyLabel = history?.visible ? "Hide version history" : "Show version history";
  const historyHeading = useRef<HTMLHeadingElement>(null);
  const focusHistory = useRef(false);
  useLayoutEffect(() => {
    if (!focusHistory.current || disabled) return;
    focusHistory.current = false;
    historyHeading.current?.focus();
  }, [disabled, history]);
  const [progress, setProgress] = useState(0);
  const [dirty, setDirty] = useState(false);
  const guard = useDraftGuard();
  useDirtyDraft(dirty, client);
  const editorEpoch=useRef(0);
  const reset = () => {
    editorEpoch.current++;
    setSaveStatus(undefined);
    setCurrent(undefined);
    setViewedRevision(undefined);
    setViewedMetadata(undefined);
    setTitle("");
    setBody("");
    setSavedBody("");
    setLogins([{ ...emptyLogin, id: 0 }]);
    setNotesOpen(false);
    setFile(undefined);
    setHistory(undefined);
    setProgress(0);
    setDirty(false);
    setNoteView("edit");
    setEditorKey((k) => k + 1);
  };
  const startNewDocument = () => {
    reset();
    setKind("note");
    const ticket = client.session.capture();
    requestAnimationFrame(() => {
      if (client.session.capture() === ticket) titleInput.current?.focus();
    });
  };
  const open = async (item: Item, revision: Revision = item.revision) => {
    const g = client.session.capture();
    const epoch = editorEpoch.current;
    const sameDocument = current && b64(bytes(current.revision.object)) === b64(bytes(item.revision.object));
    const retainedHistory = sameDocument ? history : undefined;
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
      const text = new TextDecoder().decode(doc.plaintext);
      const credential = doc.metadata.kind === "credential" ? parseCredential(text) : undefined;
      reset();
      setCurrent(item);
      setViewedRevision(revision);
      setViewedMetadata(doc.metadata);
      setHistory(retainedHistory);
      setTitle(doc.metadata.title);
      setKind(doc.metadata.kind);
      if (credential) {
        setLogins(credential.logins.map(login => ({ ...login, id: nextLoginId.current++ })));
        setBody(credential.notes);
      } else if (doc.metadata.kind === "note") {
        setBody(text);
        setSavedBody(text);
      }
    } finally {
      doc.plaintext.fill(0);
    }
  };
  const editorMetadata = (): Metadata => ({
    ...current?.metadata,
    kind,
    title,
    ...(file ? { filename: file.name, mime: file.type } : {}),
  });
  const confirmed = (
    ticket: number,
    revision: Revision,
    metadata: Metadata = editorMetadata(),
  ) => {
    client.session.check(ticket);
    const item = { revision, metadata };
    editorEpoch.current++;
    setCurrent(item);
    setViewedRevision(undefined);
    setViewedMetadata(metadata);
    setSavedBody(body);
    setDirty(false);
    setProgress(0);
    setHistory(undefined);
    onCommitted(item);
    setSaveStatus("saved");
  };
  const isCurrentBase = (item: Item) =>
    current?.revision.revision === item.revision.revision &&
    b64(bytes(current.revision.object)) === b64(bytes(item.revision.object));
  const finishRename = (ticket: number, renamed: Item, revision: Revision) => {
    client.session.check(ticket);
    pendingRename.current = undefined;
    setProgress(0);
    const item = { revision, metadata: renamed.metadata };
    if (isCurrentBase(renamed)) {
      setCurrent(item);
      setHistory(undefined);
      if (!historical) {
        setViewedRevision(undefined);
        setViewedMetadata(renamed.metadata);
        setTitle(renamed.metadata.title);
      }
    }
    onCommitted(item);
    setSaveStatus("renamed");
  };
  const rename = (item: Item, name: string) => run(async () => {
    const ticket = client.session.capture();
    const doc = await client.read(item.revision);
    let plaintext = doc.plaintext;
    try {
      client.session.check(ticket);
      if (doc.metadata.kind === "credential") {
        const credential: unknown = JSON.parse(new TextDecoder().decode(plaintext));
        if (!credential || typeof credential !== "object" || Array.isArray(credential))
          throw Error("InvalidInput");
        plaintext = utf8.encode(JSON.stringify({ ...credential, label: name }));
      }
      const renamed = { ...item, metadata: { ...doc.metadata, title: name } };
      pendingRename.current = renamed;
      const revision = await client.save(renamed.metadata, plaintext, item, (n) => {
        client.session.check(ticket);
        setProgress(n);
      });
      finishRename(ticket, renamed, revision);
    } finally {
      if (plaintext !== doc.plaintext) plaintext.fill(0);
      doc.plaintext.fill(0);
      if (!client.hasPendingSave) pendingRename.current = undefined;
    }
  });
  const save = () => {
    if (readOnly || !dirty || loginProblem) return;
    run(async () => {
      const g = client.session.capture();
      let plain: Uint8Array | undefined;
      setSaving(true);
      try {
        let metadata: Metadata = { kind, title };
        if (kind === "attachment") {
          if (!file || file.size > 10 * 1024 * 1024) throw Error("SizeLimit");
          plain = new Uint8Array(await file.arrayBuffer());
          metadata = { ...metadata, filename: file.name, mime: file.type };
        } else {
          plain = utf8.encode(
            kind === "credential"
              ? serializeCredential(title, logins.filter(login => !isBlankLogin(login)), body)
              : body,
          );
          if (plain.length > 256 * 1024) throw Error("SizeLimit");
        }
        client.session.check(g);
        const revision = await client.save(metadata, plain, current, (n) => {
          client.session.check(g);
          setProgress(n);
        });
        client.session.check(g);
        confirmed(g, revision, metadata);
        if (kind === "credential") setLogins(current => current.filter(login => !isBlankLogin(login)));
      } finally {
        plain?.fill(0);
        setSaving(false);
      }
    });
  };
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
    setDirty(true);
    setSaveStatus(undefined);
  };
  const pendingSave = client.hasPendingSave;
  const saved = saveStatus === "saved";
  const displayedRevision = viewedRevision ?? current?.revision;
  const displayedObject = displayedRevision && b64(bytes(displayedRevision.object));
  const readOnly =
    !canEdit || disabled || writesDisabled || pendingSave || !!displayedRevision?.deleted || historical;
  const byteCount = utf8.encode(body).length;
  const loginProblem = kind === "credential" ? credentialProblem(logins) : undefined;
  const showNotes = notesOpen || body !== "";
  const kindLabel = (k: Metadata["kind"]) =>
    k === "credential" ? "Credential" : k === "attachment" ? "Attachment" : "Note";
  return (
    <VaultPanel label="Private documents" sensitive className="vault-documents">
      {saveStatus === "renamed" ? (
        <output aria-live="polite">Name changed.</output>
      ) : null}
      <output className="sr-only" aria-live="polite">
        {saving ? "Saving document…" : saved ? "Saved." : ""}
      </output>
      {canEdit && pendingSave ? (
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
              disabled={disabled}
              onClick={() =>
                run(async () => {
                  const ticket = client.session.capture();
                  const renamed = pendingRename.current;
                  if (!renamed) setSaving(true);
                  try {
                    const revision = await client.resumeSave((n) => {
                      client.session.check(ticket);
                      setProgress(n);
                    });
                    if (renamed) finishRename(ticket, renamed, revision);
                    else confirmed(ticket, revision);
                  } finally {
                    setSaving(false);
                    if (!client.hasPendingSave) pendingRename.current = undefined;
                  }
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
                  const renamed = pendingRename.current;
                  let revision: Revision | undefined;
                  const result = await client.cancelSave((committed) => { revision = committed; });
                  client.session.check(ticket);
                  pendingRename.current = undefined;
                  if ("Committed" in result) {
                    if (!revision) throw Error("InvalidReceipt");
                    if (renamed) finishRename(ticket, renamed, revision);
                    else {
                      onCommitted({ revision, metadata: editorMetadata() });
                      reset();
                      setSaveStatus("saved");
                    }
                  } else {
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
          {canEdit ? (
            <div className="vault-list-actions">
              <VaultButton
                tone="primary"
                size="icon"
                aria-label="New document"
                title="New document"
                disabled={disabled || pendingSave}
                onClick={() => guard.protect(startNewDocument)}
              >
                <Plus size={16} aria-hidden />
              </VaultButton>
            </div>
          ) : null}
          <div className="vault-document-items">
            {items.map((item) => (
              <div className="vault-document-card" key={b64(bytes(item.revision.object))}>
              <VaultButton
                disabled={disabled || pendingSave}
                aria-pressed={displayedObject === b64(bytes(item.revision.object))}
                onClick={() => {
                  if (
                    displayedRevision &&
                    displayedObject === b64(bytes(item.revision.object)) &&
                    displayedRevision.revision === item.revision.revision &&
                    displayedRevision.deleted === item.revision.deleted
                  ) return;
                  guard.protect(() => run(() => open(item)));
                }}
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
              {canEdit && (canPurge || !item.revision.deleted) ? <DocumentActions
                key={String(item.revision.revision)}
                item={item}
                client={client}
                disabled={disabled || pendingSave}
                writesDisabled={writesDisabled}
                canPurge={canPurge}
                onRename={rename}
                onDelete={(target, permanent) => run(async () => {
                  const ticket = client.session.capture();
                  const epoch = editorEpoch.current;
                  if (permanent) await client.purgeObject(target.revision);
                  else await client.deleteObject(target.revision);
                  client.session.check(ticket);
                  if (current && b64(bytes(current.revision.object)) === b64(bytes(target.revision.object)) && editorEpoch.current === epoch) reset();
                  await refresh();
                })}
              /> : null}
              </div>
            ))}
            {!items.length ? (
              <p className="vault-document-empty">
                {canEdit ? "No documents yet. Create a note, credential or attachment." : "No documents yet."}
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
            <div className="vault-editor-bar-title">
              {canEdit ? (
                <VaultField
                  ref={titleInput}
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
              ) : current ? (
                <h3 className="vault-editor-readonly-title">{title || "Untitled"}</h3>
              ) : null}
            </div>
            <div className="vault-editor-bar-actions">
              {current ? <span className="vault-editor-kind-badge">{kindLabel(kind)}</span> : canEdit ? (
                <label className="vault-field vault-editor-kind">
                  <span className="sr-only">Document type</span>
                  <select
                    className="vault-select"
                    value={kind}
                    disabled={readOnly}
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
              ) : null}
              {canEdit && kind === "note" && !displayedRevision?.deleted ? (
                <fieldset className="vault-view-switch">
                  <legend className="sr-only">Note view</legend>
                  <VaultButton size="sm" tone="ghost" aria-pressed={noteView === "edit"} onClick={() => setNoteView("edit")}>Edit</VaultButton>
                  <VaultButton size="sm" tone="ghost" aria-pressed={noteView === "preview"} onClick={() => setNoteView("preview")}>Preview</VaultButton>
                </fieldset>
              ) : null}
              {current ? (
                <>
                  <VaultButton
                    size="icon"
                    aria-label={historyLabel}
                    aria-expanded={!!history?.visible}
                    title={historyLabel}
                    tone="ghost"
                    disabled={disabled}
                    onClick={() => {
                      if (history) {
                        focusHistory.current = !history.visible;
                        setHistory({ ...history, visible: !history.visible });
                        return;
                      }
                      run(async () => {
                        const g = client.session.capture();
                        const page = await client.history(current.revision);
                        client.session.check(g);
                        focusHistory.current = true;
                        setHistory({ entries: page.entries, cursor: page.next[0], visible: true });
                      });
                    }}
                  >
                    <History size={14} aria-hidden />
                  </VaultButton>
                  {!displayedRevision?.deleted && (canEdit || kind !== "credential") ? (
                    <VaultButton
                      size="icon"
                      aria-label="Download document"
                      title="Download document"
                      tone="ghost"
                      disabled={disabled}
                      onClick={() => run(() => download(displayedRevision!))}
                    >
                      <Download size={14} aria-hidden />
                    </VaultButton>
                  ) : null}
                </>
              ) : null}
              {progress > 0 ? (
                <output className="vault-editor-progress">
                  Upload {progress}%
                </output>
              ) : null}
              {canEdit && !displayedRevision?.deleted ? (
                <VaultButton
                  tone="primary"
                  size="icon"
                  className="vault-editor-save"
                  aria-label="Save document"
                  aria-busy={saving}
                  title={saving ? "Saving document…" : saved ? "Document saved" : dirty && loginProblem ? loginProblem : "Save document"}
                  disabled={
                    readOnly || !dirty || (kind === "attachment" && !file) || !!loginProblem
                  }
                  onClick={save}
                >
                  {saving ? <LoaderCircle className="vault-save-spinner" aria-hidden /> :
                    saved ? <Check className="vault-save-check" aria-hidden /> :
                    <Save aria-hidden />}
                </VaultButton>
              ) : null}
            </div>
          </div>
          <div className="vault-editor-body">
            {current && history?.visible ? (
              <div className="vault-history">
                <h3 ref={historyHeading} tabIndex={-1}>Version history</h3>
                {history.entries.map((revision) => (
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
                {history.cursor !== undefined ? (
                  <VaultButton
                    size="sm"
                    tone="ghost"
                    disabled={disabled}
                    onClick={() =>
                      run(async () => {
                        const g = client.session.capture(),
                          page = await client.history(
                            current.revision,
                            history.cursor,
                          );
                        client.session.check(g);
                        setHistory({
                          ...history,
                          entries: [...history.entries, ...page.entries],
                          cursor: page.next[0],
                        });
                      })
                    }
                  >
                    Load more history
                  </VaultButton>
                ) : null}
              </div>
            ) : null}
            {!displayedRevision?.deleted ? (
              !canEdit ? (
                current ? (
                  <VaultReadOnly
                    key={editorKey}
                    content={kind === "note" ? { kind, body }
                      : kind === "credential" ? { kind, logins, notes: body }
                      : { kind }}
                  />
                ) : null
              ) : kind === "note" ? (
                <>
                  <div className="vault-editor-frame" hidden={noteView === "preview"}>
                    <MarkdownEditor
                      key={editorKey}
                      content={body}
                      indentWithTab={false}
                      sensitiveCleanup={sensitiveCleanup}
                      disabled={readOnly}
                      lineCount={body.split("\n").length}
                      byteCount={byteCount}
                      saveState={saving ? "saving" : dirty ? "dirty" : "idle"}
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
                  {noteView === "preview" ? (
                    <div className="vault-preview-pane">
                      {body.trim()
                        ? <VaultPreview content={body} />
                        : <p className="vault-preview-empty">Nothing to preview yet.</p>}
                    </div>
                  ) : null}
                </>
              ) : kind === "credential" ? (
                <div className="vault-credential">
                  <div className="vault-credential-logins">
                    {logins.map(({ id, focusUsername, ...login }, index) => (
                      <CredentialLoginFields
                        key={`${editorKey}:${id}`}
                        login={login}
                        number={index + 1}
                        focusUsername={focusUsername}
                        readOnly={readOnly}
                        disabled={disabled}
                        onChange={(value) => {
                          setLogins(current => current.map(entry => entry.id === id ? { ...entry, ...value } : entry));
                          changed();
                        }}
                        onRemove={!historical && logins.length > 1 ? () => {
                          focusAddLogin.current = true;
                          setLogins(current => current.filter(entry => entry.id !== id));
                          changed();
                        } : undefined}
                      />
                    ))}
                  </div>
                  {!historical ? (
                    <VaultButton ref={addLoginButton} size="sm" tone="ghost" className="vault-credential-add" disabled={readOnly} onClick={() => {
                      const id = nextLoginId.current++;
                      setLogins(current => [...current, { ...emptyLogin, id, focusUsername: true }]);
                      changed();
                    }}>
                      <Plus size={14} aria-hidden />
                      Add login
                    </VaultButton>
                  ) : null}
                  {dirty && loginProblem ? <output className="vault-field-hint">{loginProblem}</output> : null}
                  {showNotes ? (
                    <label className="vault-field">
                      <span>Credential notes</span>
                      <textarea
                        ref={notesInput}
                        className="vault-textarea"
                        value={body}
                        disabled={readOnly}
                        onChange={(e) => {
                          setBody(e.target.value);
                          changed();
                        }}
                      />
                    </label>
                  ) : !readOnly ? (
                    <VaultButton size="sm" tone="ghost" className="vault-credential-add" onClick={() => {
                      setNotesOpen(true);
                      requestAnimationFrame(() => notesInput.current?.focus());
                    }}>
                      <Plus size={14} aria-hidden />
                      Add notes
                    </VaultButton>
                  ) : null}
                  <p className="vault-field-hint">The clipboard is not cleared automatically.</p>
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

          </div>

        </div>
      </div>
    </VaultPanel>
  );
}

export function VaultDocuments(props:Parameters<typeof Documents>[0]){return <DraftGuardProvider><Documents {...props}/></DraftGuardProvider>;}
