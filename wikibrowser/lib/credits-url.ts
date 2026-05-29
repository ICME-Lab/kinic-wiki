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
  if (!/^[0-9]+$/.test(trimmed)) return "credits must be a positive integer";
  const credits = BigInt(trimmed);
  if (credits <= 0n) return "credits must be positive";
  if (credits > MAX_U64) return "credits must be <= u64::MAX";
  return credits;
}

export function purchaseQueryString(input: CreditsTarget): string {
  const params = new URLSearchParams();
  params.set("database_id", input.databaseId);
  return params.toString();
}
