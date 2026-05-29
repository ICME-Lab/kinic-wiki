// Where: purchase page URL and amount validation.
// What: validates the target database from URL state and parses user-entered credits.
// Why: purchase amount is UI state, not a query parameter contract.
export type CreditsTarget = {
  databaseId: string;
};

const MAX_U64 = 18_446_744_073_709_551_615n;

export function parseCreditsTarget(input: URLSearchParams): CreditsTarget | string {
  const databaseId = input.get("database_id") ?? input.get("databaseId") ?? "";
  if (!databaseId.trim()) return "database_id is required";
  if (!/^[a-zA-Z0-9_-]+$/.test(databaseId)) return "database_id contains unsupported characters";
  return { databaseId };
}

export function parseCreditsAmountInput(value: string): bigint | string {
  const trimmed = value.trim();
  const match = /^([0-9]+)(?:\.([0-9]{1,3}))?$/.exec(trimmed);
  if (!match) return "credits must be a positive number with up to 3 decimals";
  const creditUnits = BigInt(match[1]) * 1000n + BigInt((match[2] ?? "").padEnd(3, "0") || "0");
  if (creditUnits <= 0n) return "credits must be positive";
  if (creditUnits > MAX_U64) return "credit units must be <= u64::MAX";
  return creditUnits;
}

export function purchaseQueryString(input: CreditsTarget): string {
  const params = new URLSearchParams();
  params.set("database_id", input.databaseId);
  return params.toString();
}
