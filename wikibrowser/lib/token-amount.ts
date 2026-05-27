// Where: shared KINIC balance formatting.
// What: converts ledger e8s values into compact KINIC display text.
// Why: UI must name the billing token as KINIC, not the generic "token".
const E8S_PER_TOKEN = 100_000_000n;
const E8S_PER_DISPLAY_UNIT = 100_000n;

export function formatTokenAmountFromE8s(value: bigint | string | null | undefined): string {
  const e8s = parseE8s(value);
  if (e8s === 0n) return "0.000 KINIC";
  const whole = e8s / E8S_PER_TOKEN;
  const thousandths = (e8s % E8S_PER_TOKEN) / E8S_PER_DISPLAY_UNIT;
  if (whole === 0n && thousandths === 0n) return "<0.001 KINIC";
  return `${whole.toString()}.${thousandths.toString().padStart(3, "0")} KINIC`;
}

function parseE8s(value: bigint | string | null | undefined): bigint {
  if (typeof value === "bigint") return value;
  if (!value || !/^[0-9]+$/.test(value)) return 0n;
  return BigInt(value);
}
