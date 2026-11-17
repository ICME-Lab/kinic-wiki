import { describe, it, expect } from "vitest";
import type { VaultTransfer } from "@kinic/credit-bridge-candid";
import { quoteEstimate } from "./vault-credit-estimate";
const estimate = (
  balance: bigint,
  fee: bigint,
  requested: VaultTransfer["requested"],
) =>
  quoteEstimate({
    balance_at_quote: balance,
    estimated_execution_fee_cycles: fee,
    requested,
  } as VaultTransfer);
describe("credit quote economics", () => {
  it("All subtracts estimated fees from recipient credit, consumes the source snapshot and leaves zero", () => {
    expect(estimate(100n, 7n, { All: null })).toEqual({
      recipient: 93n,
      sourceDebit: 100n,
      remaining: 0n,
    });
    expect(estimate(5n, 7n, { All: null })).toEqual({
      recipient: 0n,
      sourceDebit: 5n,
      remaining: 0n,
    });
  });
  it("Exact keeps integer precision and clamps an unaffordable snapshot remainder to zero", () => {
    expect(
      estimate(9007199254741093n, 7n, { Exact: 9007199254740993n }),
    ).toEqual({
      recipient: 9007199254740993n,
      sourceDebit: 9007199254741000n,
      remaining: 93n,
    });
    expect(estimate(100n, 7n, { Exact: 100n })).toEqual({
      recipient: 100n,
      sourceDebit: 107n,
      remaining: 0n,
    });
  });
});
