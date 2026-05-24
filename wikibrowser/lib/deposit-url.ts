export type DepositQuery = {
  databaseId: string;
  amountE8s: bigint;
};

export function parseDepositQuery(input: URLSearchParams): DepositQuery | string {
  const databaseId = input.get("database_id") ?? input.get("databaseId") ?? "";
  const amountText = input.get("amount_e8s") ?? input.get("amountE8s") ?? "";
  if (!databaseId.trim()) return "database_id is required";
  if (!/^[a-zA-Z0-9_-]+$/.test(databaseId)) return "database_id contains unsupported characters";
  const amount = parseE8s(amountText);
  if (typeof amount === "string") return amount;
  return { databaseId, amountE8s: amount };
}

export function parseE8s(value: string): bigint | string {
  if (!/^[0-9]+$/.test(value)) return "amount_e8s must be an integer";
  const amount = BigInt(value);
  if (amount <= 0n) return "amount_e8s must be positive";
  return amount;
}

export function depositQueryString(input: DepositQuery): string {
  const params = new URLSearchParams();
  params.set("database_id", input.databaseId);
  params.set("amount_e8s", input.amountE8s.toString());
  return params.toString();
}
