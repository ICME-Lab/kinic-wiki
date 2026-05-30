// Where: purchase page URL and amount validation.
// What: validates the target database from URL state and parses user-entered KINIC.
// Why: purchase amount is UI state, not a query parameter contract.
export type CyclesTarget = {
  databaseId: string;
};

const MAX_U64 = 18_446_744_073_709_551_615n;

export function parseCyclesTarget(input: URLSearchParams): CyclesTarget | string {
  const databaseId = input.get("database_id") ?? input.get("databaseId") ?? "";
  if (!databaseId.trim()) return "database_id is required";
  if (!/^[a-zA-Z0-9_-]+$/.test(databaseId)) return "database_id contains unsupported characters";
  return { databaseId };
}

export function parseKinicAmountE8sInput(value: string): bigint | string {
  const trimmed = value.trim();
  const match = /^([0-9]+)(?:\.([0-9]{1,8}))?$/.exec(trimmed);
  if (!match) return "KINIC must be a positive number with up to 8 decimals";
  const amountE8s = BigInt(match[1]) * 100_000_000n + BigInt((match[2] ?? "").padEnd(8, "0") || "0");
  if (amountE8s <= 0n) return "KINIC amount must be positive";
  if (amountE8s > MAX_U64) return "KINIC amount e8s must be <= u64::MAX";
  return amountE8s;
}

export function purchaseQueryString(input: CyclesTarget): string {
  const params = new URLSearchParams();
  params.set("database_id", input.databaseId);
  return params.toString();
}
