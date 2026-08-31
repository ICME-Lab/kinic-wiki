// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { balanceCanFund, useFundingSourceChoice } from "@/app/kinic-funding-source-selector";

afterEach(cleanup);

describe("KINIC funding source selection", () => {
  it("uses the exact base-unit boundary", () => {
    expect(balanceCanFund("100199999", 100_200_000n)).toBe(false);
    expect(balanceCanFund("100200000", 100_200_000n)).toBe(true);
    expect(balanceCanFund(null, 100_200_000n)).toBe(false);
    expect(balanceCanFund("invalid", 100_200_000n)).toBe(false);
  });

  it("prefers an available wallet and only falls back when that selected wallet disconnects", () => {
    const { result, rerender } = renderHook(
      ({ walletAvailable, walletSessionReady }) => useFundingSourceChoice(walletAvailable, walletSessionReady),
      { initialProps: { walletAvailable: true, walletSessionReady: true } }
    );
    expect(result.current.selected).toBe("wallet");

    act(() => result.current.select("ii"));
    rerender({ walletAvailable: false, walletSessionReady: true });
    rerender({ walletAvailable: true, walletSessionReady: true });
    expect(result.current.selected).toBe("ii");

    act(() => result.current.select("wallet"));
    rerender({ walletAvailable: false, walletSessionReady: true });
    expect(result.current.selected).toBe("ii");
  });

  it("adopts a wallet found while the stored session is being restored", () => {
    const { result, rerender } = renderHook(
      ({ walletAvailable, walletSessionReady }) => useFundingSourceChoice(walletAvailable, walletSessionReady),
      { initialProps: { walletAvailable: false, walletSessionReady: false } }
    );
    expect(result.current.selected).toBe("ii");
    rerender({ walletAvailable: true, walletSessionReady: false });
    rerender({ walletAvailable: true, walletSessionReady: true });
    expect(result.current.selected).toBe("wallet");
  });

  it("keeps Internet Identity selected when a wallet connects after restoration", () => {
    const { result, rerender } = renderHook(
      ({ walletAvailable, walletSessionReady }) => useFundingSourceChoice(walletAvailable, walletSessionReady),
      { initialProps: { walletAvailable: false, walletSessionReady: true } }
    );
    rerender({ walletAvailable: true, walletSessionReady: true });
    expect(result.current.selected).toBe("ii");
  });
});
