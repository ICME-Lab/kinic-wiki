/** Pure wire conversion, shared without depending on a client or private session. */
import type { Generation } from "./contracts";
export const bytes = (x: Uint8Array | number[]) => new Uint8Array(x);
export function ok<T>(r: { Ok: T } | { Err: unknown }): T {
  if ("Ok" in r) return r.Ok;
  const e = r.Err;
  throw Error(e && typeof e === "object" ? Object.keys(e)[0] : "RequestFailed");
}
export const cryptoGeneration = (g: Generation) => ({
  ...g,
  version: 2 as const,
  canister: g.canister.toText(),
  owner: g.owner.toText(),
  vault: bytes(g.vault),
  nonce: bytes(g.nonce),
});
