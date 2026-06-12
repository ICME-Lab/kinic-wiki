"use client";

import { cycleTone, formatCycles, formatRawCycles, type CycleTone } from "@/lib/cycles";

export function CycleBattery({ cyclesBalance }: { cyclesBalance: string | null }) {
  const cycles = parseCyclesBalance(cyclesBalance);
  const tone = cycleTone(cycles);
  const label = cycles === null ? "--" : formatCycles(cycles);
  const title = titleForCycles(cycles);
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

function parseCyclesBalance(value: string | null): bigint | null {
  if (value === null) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function titleForCycles(cycles: bigint | null): string {
  if (cycles !== null) {
    return `${formatRawCycles(cycles)} database cycles available`;
  }
  return "Database cycle balance unavailable";
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
