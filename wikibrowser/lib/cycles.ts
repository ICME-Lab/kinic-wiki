export type CycleTone = "blue" | "amber" | "red" | "gray";

export const KINIC_LEDGER_FEE_E8S = 100_000n;
export const KINIC_DECIMALS = 8;
export const CYCLES_PER_KINIC = 234_500_000_000n;
export const MAX_CANISTER_I64 = 9_223_372_036_854_775_807n;
export const MAX_LEDGER_U64 = 18_446_744_073_709_551_615n;

export function kinicBaseUnitsPerToken(): bigint {
  return 10n ** BigInt(KINIC_DECIMALS);
}

const MILLION = 1_000_000n;
const BILLION = 1_000_000_000n;
const TRILLION = 1_000_000_000_000n;
const AMBER_CYCLES = 1n * TRILLION;
const BLUE_CYCLES = 5n * TRILLION;

export function formatCycles(value: bigint): string {
  if (value >= TRILLION) {
    return `${formatFixed(value, TRILLION)}T`;
  }
  if (value >= BILLION) {
    return `${formatFixed(value, BILLION)}B`;
  }
  return `${formatFixed(value, MILLION)}M`;
}

export function cycleTone(value: bigint | null): CycleTone {
  if (value === null) {
    return "gray";
  }
  if (value >= BLUE_CYCLES) {
    return "blue";
  }
  if (value >= AMBER_CYCLES) {
    return "amber";
  }
  return "red";
}

export function formatRawCycles(value: bigint): string {
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatFixed(value: bigint, unit: bigint): string {
  const scaled = (value * 100n) / unit;
  const whole = scaled / 100n;
  const fraction = (scaled % 100n).toString().padStart(2, "0");
  return `${whole}.${fraction}`;
}
