import { useState, useCallback } from "react";
import { bytes, ok, type Item, type VaultClient } from "@kinic/vault-client";
import { utf8 } from "@kinic/vault-crypto";
import { b64, type Metadata } from "@kinic/vault-crypto/documents";
import type { Revision } from "@kinic/vault-client/contracts";
import { MarkdownEditor } from "@kinic/vault-ui/editor";
import { VaultPreview } from "./preview";
import { VaultButton, VaultField, VaultPanel } from "./ui";
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
        reset();
        await refresh();
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
  const changed = () => setDirty(true);
  const readOnly = disabled || writesDisabled || !!current?.revision.deleted;
  const byteCount = utf8.encode(body).length;
  return (
    <VaultPanel label="Private documents" sensitive>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">Private documents</h2>
        <VaultButton disabled={disabled} onClick={() => run(refresh)}>
          Refresh documents
        </VaultButton>
      </div>
      <VaultField
        label="Search this Vault locally"
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="grid min-w-0 gap-4 xl:grid-cols-[200px_minmax(0,1fr)]">
        <div className="grid min-w-0 content-start gap-2">
          <VaultButton disabled={disabled} onClick={reset}>
            New document
          </VaultButton>
          {items
            .filter((item) =>
              (item.searchText ?? item.metadata.title)
                .toLocaleLowerCase()
                .includes(query.toLocaleLowerCase()),
            )
            .map((item) => (
              <VaultButton
                key={b64(bytes(item.revision.object))}
                disabled={disabled}
                onClick={() => run(() => open(item))}
                className="break-words text-left"
              >
                {item.metadata.title || "Untitled"}
                {item.revision.deleted ? " (deleted)" : ""}
              </VaultButton>
            ))}
          {!items.length ? (
            <p className="text-sm text-muted">
              No documents yet. Create a note, credential or attachment.
            </p>
          ) : null}
        </div>
        <div className="grid min-w-0 content-start gap-3">
          <VaultField
            label="Document title"
            value={title}
            maxLength={512}
            disabled={readOnly}
            onChange={(e) => {
              setTitle(e.target.value);
              changed();
            }}
          />
          <label className="grid gap-1 text-sm font-medium">
            Document type
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
                disabled={
                  readOnly || !dirty || (kind === "attachment" && !file)
                }
                onClick={save}
              >
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
                      const page = ok(
                        await client.actor.list_history(
                          current.revision.vault,
                          current.revision.object,
                          18446744073709551615n,
                        ),
                      );
                      client.session.check(g);
                      setHistory(page.entries);
                      setHistoryCursor(page.next[0]);
                    })
                  }
                >
                  Show version history
                </VaultButton>
                {!current.revision.deleted ? (
                  <>
                    <VaultButton
                      disabled={disabled}
                      onClick={() => run(() => download(current.revision))}
                    >
                      Download document
                    </VaultButton>
                    <VaultButton
                      disabled={disabled || writesDisabled}
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
                      Delete document
                    </VaultButton>
                  </>
                ) : null}
                <VaultButton
                  disabled={disabled || writesDisabled}
                  onClick={() => {
                    if (
                      !window.confirm(
                        "Permanently delete this document and its history? Existing backups are unchanged.",
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
                            page = ok(
                              await client.actor.list_history(
                                current.revision.vault,
                                current.revision.object,
                                historyCursor,
                              ),
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
