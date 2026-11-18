const MILLION = 1_000_000n;
const BILLION = 1_000_000_000n;
const TRILLION = 1_000_000_000_000n;

export function formatCycles(value: bigint): string {
  if (value >= TRILLION) {
    return `${formatFixed(value, TRILLION)}T`;
  }
  if (value >= BILLION) {
    return `${formatFixed(value, BILLION)}B`;
  }
  return `${formatFixed(value, MILLION)}M`;
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
