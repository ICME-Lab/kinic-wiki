"use client";

import type { Identity } from "@icp-sdk/core/agent";
import { ExternalLink, Globe2, Link, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "@/components/ui/toast";
import { useModalDialog } from "@/components/use-modal-dialog";
import { publicNodePath, publicNodeUrl } from "@/lib/share-links";
import type { DatabaseRole, NodePublication } from "@/lib/types";
import {
  getNodePublication,
  publishNodeAuthenticated,
  unpublishNodeAuthenticated
} from "@/lib/vfs-client";

export function NodePublicationControls({
  canisterId,
  databaseId,
  path,
  role,
  identity,
  onPublicationStateChange
}: {
  canisterId: string;
  databaseId: string;
  path: string;
  role: DatabaseRole | null;
  identity: Identity | null;
  onPublicationStateChange?: (path: string, isPublished: boolean) => void;
}) {
  const [publication, setPublication] = useState<NodePublication | null>(null);
  const [loading, setLoading] = useState(true);
  const [mutating, setMutating] = useState(false);
  const [pendingAction, setPendingAction] = useState<PublicationAction | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setPublication(null);
    setPendingAction(null);
    if (!identity || !role) {
      setLoading(false);
      return;
    }
    void getNodePublication(canisterId, databaseId, path, identity)
      .then((next) => {
        if (!cancelled) {
          setPublication(next);
          onPublicationStateChange?.(path, next !== null);
        }
      })
      .catch(() => {
        if (!cancelled) setPublication(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [canisterId, databaseId, identity, onPublicationStateChange, path, role]);

  if (!identity || !role) return null;
  if (loading) return <Loader2 aria-label="Checking publication status" className="mx-2 animate-spin text-muted" size={16} />;

  async function publish() {
    setMutating(true);
    try {
      const next = await publishNodeAuthenticated(canisterId, databaseId, path, identity!);
      setPublication(next);
      onPublicationStateChange?.(path, true);
      toast.success("Published");
      setPendingAction(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not publish page");
    } finally {
      setMutating(false);
    }
  }

  async function unpublish() {
    setMutating(true);
    try {
      await unpublishNodeAuthenticated(canisterId, databaseId, path, identity!);
      setPublication(null);
      onPublicationStateChange?.(path, false);
      toast.success("Unpublished");
      setPendingAction(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not unpublish page");
    } finally {
      setMutating(false);
    }
  }

  async function copyLink() {
    if (!publication || mutating) return;
    try {
      await navigator.clipboard.writeText(publicNodeUrl(publication.publicId, window.location.origin));
      toast.success("Public link copied");
    } catch {
      toast.error("Could not copy public link");
    }
  }

  if (!publication) {
    return role === "owner" ? (
      <>
        <div className={controlGroupClass}>
          <button className={inactiveButtonClass} disabled={mutating} type="button" onClick={() => setPendingAction("publish")}>
            <Globe2 size={14} />
            Publish
          </button>
        </div>
        {pendingAction === "publish" ? (
          <PublicationConfirmationDialog action="publish" busy={mutating} path={path} onCancel={() => setPendingAction(null)} onConfirm={() => void publish()} />
        ) : null}
      </>
    ) : null;
  }

  return (
    <>
      <div className={controlGroupClass}>
        <a className={activeButtonClass} href={publicNodePath(publication.publicId)} target="_blank" rel="noreferrer">
          <ExternalLink size={14} />
          Published
        </a>
        {role === "owner" ? (
          <>
            <button aria-label="Copy public link" className={iconButtonClass} disabled={mutating} type="button" onClick={() => void copyLink()}>
              <Link size={14} />
            </button>
            <button className={inactiveButtonClass} disabled={mutating} type="button" onClick={() => setPendingAction("unpublish")}>
              Unpublish
            </button>
          </>
        ) : null}
      </div>
      {pendingAction === "unpublish" ? (
        <PublicationConfirmationDialog action="unpublish" busy={mutating} path={path} onCancel={() => setPendingAction(null)} onConfirm={() => void unpublish()} />
      ) : null}
    </>
  );
}

type PublicationAction = "publish" | "unpublish";

function PublicationConfirmationDialog({
  action,
  busy,
  path,
  onCancel,
  onConfirm
}: {
  action: PublicationAction;
  busy: boolean;
  path: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { dialogRef, handleCancel } = useModalDialog(onCancel, busy);
  const publishing = action === "publish";
  const title = publishing ? "Publish page?" : "Unpublish page?";
  const confirmLabel = publishing ? "Publish" : "Unpublish";

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="publication-confirmation-title"
      aria-modal="true"
      className="fixed inset-0 z-50 m-0 hidden h-full w-full max-h-none max-w-none items-center justify-center border-0 bg-ink/30 px-4 open:flex"
      onCancel={handleCancel}
    >
      <button aria-label="Close publication confirmation dialog" className="absolute inset-0" disabled={busy} tabIndex={-1} type="button" onClick={onCancel} />
      <div className="relative z-10 w-full max-w-md rounded-lg border border-line bg-paper p-5 shadow-lg">
        <h3 id="publication-confirmation-title" className="text-lg font-semibold text-ink">
          {title}
        </h3>
        <p className="mt-3 text-sm leading-6 text-muted">
          {publishing
            ? "Anyone with the public link can read this page. Future changes to this page will also be public."
            : "The current public link will stop working. Publishing this page again will create a new link."}
        </p>
        <p className="mt-3 break-all rounded-lg border border-line bg-white px-3 py-2 font-mono text-xs text-ink">{path}</p>
        <div className="mt-5 flex justify-end gap-2">
          <button data-modal-initial-focus className={cancelButtonClass} disabled={busy} type="button" onClick={onCancel}>
            Cancel
          </button>
          <button
            aria-busy={busy || undefined}
            className={publishing ? confirmButtonClass : dangerConfirmButtonClass}
            disabled={busy}
            type="button"
            onClick={onConfirm}
          >
            {busy ? <Loader2 aria-hidden className="animate-spin" size={15} /> : null}
            {busy ? `${confirmLabel}ing...` : confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}

const controlGroupClass = "flex shrink-0 items-center rounded-2xl border border-line bg-white p-1 text-xs shadow-[0_4px_10px_#14142b0a] sm:text-sm";
const activeButtonClass = "inline-flex items-center gap-1.5 rounded-xl bg-accent px-2 py-1.5 font-medium text-white sm:px-3";
const inactiveButtonClass = "inline-flex items-center gap-1.5 rounded-xl px-2 py-1.5 font-medium text-muted hover:bg-accentSoft hover:text-accentText disabled:opacity-50 sm:px-3";
const iconButtonClass = "inline-flex size-7 items-center justify-center rounded-xl text-muted hover:bg-accentSoft hover:text-accentText disabled:opacity-50 sm:size-8";
const modalButtonClass = "inline-flex min-w-[96px] items-center justify-center gap-2 rounded-2xl border px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60";
const cancelButtonClass = `${modalButtonClass} border-line bg-white text-ink hover:border-accent`;
const confirmButtonClass = `${modalButtonClass} border-action bg-action font-bold text-white hover:border-accent hover:bg-accent`;
const dangerConfirmButtonClass = `${modalButtonClass} border-red-700 bg-red-700 font-bold text-white hover:bg-red-800`;
