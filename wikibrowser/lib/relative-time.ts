// Where: inspector metadata and any place that shows a stored timestamp.
// What: converts canister timestamp strings into a readable absolute and relative label.
// Why: the inspector printed raw epoch milliseconds such as 1782890407730.

const relativeFormatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

const UNITS: { limit: number; unit: Intl.RelativeTimeFormatUnit; ms: number }[] = [
  { limit: 60_000, unit: "second", ms: 1_000 },
  { limit: 3_600_000, unit: "minute", ms: 60_000 },
  { limit: 86_400_000, unit: "hour", ms: 3_600_000 },
  { limit: 2_592_000_000, unit: "day", ms: 86_400_000 },
  { limit: 31_536_000_000, unit: "month", ms: 2_592_000_000 },
  { limit: Number.POSITIVE_INFINITY, unit: "year", ms: 31_536_000_000 }
];

export type FormattedTimestamp = {
  absolute: string;
  relative: string;
};

/**
 * Accepts epoch milliseconds or seconds as a string, or the placeholder values the canister
 * returns for virtual folders ("0", "", "virtual"). Returns null when there is nothing to show.
 */
export function formatStoredTimestamp(value: string | null | undefined, now = Date.now()): FormattedTimestamp | null {
  const ms = parseStoredTimestampMs(value);
  if (ms === null) return null;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;
  const diff = ms - now;
  const magnitude = Math.abs(diff);
  const unit = UNITS.find((candidate) => magnitude < candidate.limit) ?? UNITS[UNITS.length - 1];
  return {
    absolute: date.toISOString().replace(".000Z", "Z"),
    relative: relativeFormatter.format(Math.round(diff / unit.ms), unit.unit)
  };
}

export function parseStoredTimestampMs(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const numeric = Number(trimmed);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  // Canister timestamps are milliseconds; ten-digit values are seconds.
  return trimmed.length <= 10 ? numeric * 1000 : numeric;
}

/** True when a metadata blob carries no information worth showing. */
export function isBlankMetadataJson(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return true;
  const trimmed = value.trim();
  return trimmed === "" || trimmed === "{}" || trimmed === "null" || trimmed === "[]";
}
