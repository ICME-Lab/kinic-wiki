import { StatusPill, type StatusTone } from "./status-pill";
import { formatCycles, formatRawCycles } from "./cycles";

// Billing rules stay in the app; this component only presents a cycle balance.
export function CycleBalance({
  cycles,
  title,
  tone = "neutral",
  className = "",
}: {
  cycles: bigint | null;
  title?: string;
  tone?: StatusTone;
  className?: string;
}) {
  return (
    <StatusPill
      className={`h-[38px] px-3 ${className}`}
      dot
      label={<span className="font-mono text-xs">{cycles === null ? "--" : formatCycles(cycles)}</span>}
      title={title ?? (cycles === null ? "Cycle balance unavailable" : `${formatRawCycles(cycles)} cycles available`)}
      tone={tone}
    />
  );
}
