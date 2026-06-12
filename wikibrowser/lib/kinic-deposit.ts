// Where: shared KINIC deposit input helpers.
// What: parses decimal KINIC input into ledger e8s.
// Why: deposit and withdraw forms must enforce the same positive amount rule.
export function parseKinicAmount(value: string): string | null {
  const trimmed = value.trim();
  if (!/^\d+(\.\d{0,8})?$/.test(trimmed)) return null;
  const [whole, fraction = ""] = trimmed.split(".");
  const e8s = `${whole}${fraction.padEnd(8, "0")}`.replace(/^0+(?=\d)/, "");
  if (BigInt(e8s) <= 0n) return null;
  return e8s;
}
