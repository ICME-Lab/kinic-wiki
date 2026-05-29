"use client";

import type { Identity } from "@icp-sdk/core/agent";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Clock } from "lucide-react";
import { hrefForPath } from "@/lib/paths";
import { authRequestKey } from "@/lib/request-keys";
import type { RecentNode } from "@/lib/types";
import { errorHint, errorMessage, type LoadState } from "@/lib/wiki-helpers";
import { ErrorBox } from "@/components/panel";

export function RecentPanel({ canisterId, databaseId, readIdentity, readMode = null }: { canisterId: string; databaseId: string; readIdentity: Identity | null; readMode?: "anonymous" | null }) {
  const readPrincipal = readIdentity?.getPrincipal().toText() ?? null;
  const requestKey = `${canisterId}\n${databaseId}\n${authRequestKey(readPrincipal)}`;
  const [recent, setRecent] = useState<LoadState<RecentNode[]> & { requestKey: string | null }>({
    requestKey: null,
    data: null,
    error: null,
    loading: true
  });

  useEffect(() => {
    let cancelled = false;
    import("@/lib/vfs-client")
      .then(({ recentNodes }) => recentNodes(canisterId, databaseId, 30, readIdentity ?? undefined))
      .then((data) => {
        if (!cancelled) setRecent({ requestKey, data, error: null, loading: false });
      })
      .catch((error: Error) => {
        if (!cancelled) setRecent({ requestKey, data: null, error: errorMessage(error), hint: errorHint(error), loading: false });
      });
    return () => {
      cancelled = true;
    };
  }, [canisterId, databaseId, readIdentity, requestKey]);

  const currentRecent: LoadState<RecentNode[]> = recent.requestKey === requestKey ? recent : { data: null, error: null, loading: true };

  if (currentRecent.error) return <div className="min-h-0 flex-1 p-3"><ErrorBox message={currentRecent.error} hint={currentRecent.hint} /></div>;
  if (currentRecent.loading) return <p className="min-h-0 flex-1 p-4 text-sm text-muted">Loading recent nodes</p>;
  return (
    <div className="min-h-0 flex-1 space-y-2 overflow-auto p-3">
      {currentRecent.data?.map((node) => (
        <Link
          key={node.path}
          href={hrefForPath(canisterId, databaseId, node.path, undefined, undefined, undefined, undefined, readMode)}
          className="block rounded-xl border border-line bg-white p-3 text-sm no-underline hover:border-accent"
        >
          <div className="flex items-center gap-2">
            <Clock size={14} className="text-muted" />
            <span className="truncate font-mono text-xs text-accent">{node.path}</span>
          </div>
          <div className="mt-2 flex justify-between font-mono text-[11px] text-muted">
            <span>{node.kind}</span>
            <span>{node.updatedAt}</span>
          </div>
        </Link>
      ))}
    </div>
  );
}
