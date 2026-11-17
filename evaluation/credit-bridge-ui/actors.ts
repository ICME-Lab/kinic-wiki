// Synthetic transport for browser UI verification only. Never imported by production.
import { Principal } from "../../vaultbrowser/node_modules/@icp-sdk/core/lib/esm/principal/index.js";
export const creditOrigins = () => ({
  wiki: "http://127.0.0.1:3036",
  vault: "http://localhost:3036",
});
export const wikiPrincipal = Principal.fromText("aaaaa-aa");
export const vaultPrincipal = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai");
function decode(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && "$bigint" in value)
    return BigInt((value as { $bigint: string }).$bigint);
  if (value && typeof value === "object" && "$principal" in value)
    return Principal.fromText((value as { $principal: string }).$principal);
  return value;
}
export async function call(method: string, args: unknown[] = []) {
  const response = await fetch("/fixture-api", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, args }, (_k, v) =>
      typeof v === "bigint"
        ? { $bigint: v.toString() }
        : v instanceof Uint8Array
          ? [...v]
          : v,
    ),
  });
  return JSON.parse(await response.text(), decode);
}
const actor = new Proxy(
  {},
  {
    get: (_, method) =>
      method === "then"
        ? undefined
        : (...args: unknown[]) => call(String(method), args),
  },
);
export const vaultCreditActor = async () => actor;
export const wikiCreditActor = async () => actor;
export const ownerDatabases = async () => [
  {
    databaseId: "fixture-owner-db",
    name: "Research database",
    cyclesBalance: "10000000000",
  },
];
