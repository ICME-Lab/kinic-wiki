"use client";

import { useEffect, useState } from "react";
import { cycleTone, formatCycles, formatRawCycles, type CycleTone } from "@/lib/cycles";
import type { CanisterHealth } from "@/lib/types";

type HealthState = {
  canisterId: string;
  data: CanisterHealth | null;
  error: boolean;
  loading: boolean;
};

export function CycleBattery({ canisterId }: { canisterId: string }) {
  const [health, setHealth] = useState<HealthState>({
    canisterId,
    data: null,
    error: false,
    loading: true
  });
  useEffect(() => {
    let cancelled = false;
    import("@/lib/vfs-client")
      .then(({ canisterHealth }) => canisterHealth(canisterId))
      .then((data) => {
        if (!cancelled) {
          setHealth({ canisterId, data, error: false, loading: false });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setHealth({ canisterId, data: null, error: true, loading: false });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [canisterId]);

  const current = health.canisterId === canisterId ? health : { canisterId, data: null, error: false, loading: true };
  const cycles = current.data?.cyclesBalance ?? null;
  const tone = cycleTone(cycles);
  const label = cycles === null ? "--" : formatCycles(cycles);
  const title = titleForState(current, cycles);
  return (
    <div
      className={`hidden h-[38px] shrink-0 items-center gap-2 rounded-lg border px-3 text-sm md:flex ${toneClass(tone)}`}
      title={title}
      aria-label={title}
    >
      <span className="relative h-4 w-8 rounded-[4px] border border-current p-[2px]">
        <span className={`block h-full rounded-[2px] ${fillClass(tone)}`} style={{ width: fillWidth(tone) }} />
        <span className="absolute -right-[4px] top-1/2 h-2 w-[3px] -translate-y-1/2 rounded-r-sm bg-current" />
      </span>
      <span className="font-mono text-xs">{label}</span>
    </div>
  );
}

function titleForState(state: HealthState, cycles: bigint | null): string {
  if (cycles !== null) {
    return `${formatRawCycles(cycles)} cycles available`;
  }
  if (state.loading) {
    return "Loading cycle balance";
  }
  return "Cycle balance unavailable";
}

function toneClass(tone: CycleTone): string {
  if (tone === "blue") return "border-infoLine bg-infoSoft text-infoText";
  if (tone === "amber") return "border-yellow-200 bg-yellow-50 text-yellow-800";
  if (tone === "red") return "border-red-200 bg-red-50 text-red-700";
  return "border-line bg-white text-muted";
}

function fillClass(tone: CycleTone): string {
  if (tone === "blue") return "bg-kinicCyan";
  if (tone === "amber") return "bg-yellow-500";
  if (tone === "red") return "bg-red-500";
  return "bg-muted";
}

function fillWidth(tone: CycleTone): string {
  if (tone === "blue") return "100%";
  if (tone === "amber") return "55%";
  if (tone === "red") return "18%";
  return "0%";
}
