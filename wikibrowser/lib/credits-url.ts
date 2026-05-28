// Where: purchase page URL and amount validation.
// What: validates the target database from URL state and parses user-entered KINIC amounts.
// Why: purchase amount is UI state, not a query parameter contract.
export type CreditsTarget = {
  databaseId: string;
};

const MAX_U64 = 18_446_744_073_709_551_615n;
const E8S_PER_KINIC = 100_000_000n;

export function parseCreditsTarget(input: URLSearchParams): CreditsTarget | string {
  const databaseId = input.get("database_id") ?? input.get("databaseId") ?? "";
  if (!databaseId.trim()) return "database_id is required";
  if (!/^[a-zA-Z0-9_-]+$/.test(databaseId)) return "database_id contains unsupported characters";
  return { databaseId };
}

export function parseCreditsAmountInput(value: string): bigint | string {
  const trimmed = value.trim();
  const match = /^([0-9]+)(?:\.([0-9]{1,8}))?$/.exec(trimmed);
  if (!match) return "KINIC amount must be a decimal with up to 8 fractional digits";
  const whole = BigInt(match[1]);
  const fractional = BigInt((match[2] ?? "").padEnd(8, "0"));
  const amount = whole * E8S_PER_KINIC + fractional;
  if (amount <= 0n) return "KINIC amount must be positive";
  if (amount > MAX_U64) return "KINIC amount must be <= u64::MAX";
  return amount;
}

export function purchaseQueryString(input: CreditsTarget): string {
  const params = new URLSearchParams();
  params.set("database_id", input.databaseId);
  return params.toString();
}
