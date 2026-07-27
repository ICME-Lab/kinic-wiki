"use client";

import type { Identity } from "@icp-sdk/core/agent";
import { ExternalLink, Globe2, Link, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
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

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setPublication(null);
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
      <div className={controlGroupClass}>
        <button className={inactiveButtonClass} disabled={mutating} type="button" onClick={() => void publish()}>
          {mutating ? <Loader2 className="animate-spin" size={14} /> : <Globe2 size={14} />}
          Publish
        </button>
      </div>
    ) : null;
  }

  return (
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
          <button className={inactiveButtonClass} disabled={mutating} type="button" onClick={() => void unpublish()}>
            Unpublish
          </button>
        </>
      ) : null}
    </div>
  );
}

const controlGroupClass = "flex shrink-0 items-center rounded-2xl border border-line bg-white p-1 text-xs shadow-[0_4px_10px_#14142b0a] sm:text-sm";
const activeButtonClass = "inline-flex items-center gap-1.5 rounded-xl bg-accent px-2 py-1.5 font-medium text-white sm:px-3";
const inactiveButtonClass = "inline-flex items-center gap-1.5 rounded-xl px-2 py-1.5 font-medium text-muted hover:bg-accentSoft hover:text-accentText disabled:opacity-50 sm:px-3";
const iconButtonClass = "inline-flex size-7 items-center justify-center rounded-xl text-muted hover:bg-accentSoft hover:text-accentText disabled:opacity-50 sm:size-8";
