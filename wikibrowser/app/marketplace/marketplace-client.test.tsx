// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AnchorHTMLAttributes } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { MarketplaceClient } from "./marketplace-client";

const mocks = vi.hoisted(() => ({ list: vi.fn(), replace: vi.fn() }));
vi.mock("@/lib/vfs-client", () => ({ marketListListings: mocks.list }));
vi.mock("@/lib/app-router", () => ({
  useAppPathname: () => "/marketplace",
  useAppSearchParams: () => new URLSearchParams(),
  useAppNavigate: () => ({ replace: mocks.replace })
}));
vi.mock("@/components/app-link", () => ({
  AppLink: ({ children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props}>{children}</a>
}));
afterEach(cleanup);

it("keeps loaded listings visible after an append failure and allows retry", async () => {
  const view = (id: string, name: string) => ({
    listing: {
      listingId: id, sellerPrincipal: "seller", payoutPrincipal: "seller",
      databaseId: id, priceE8s: "50000000", status: "Active", revision: "1",
      purchaseCount: "0", reportCount: "0", createdAtMs: "1", updatedAtMs: "1"
    },
    databaseMetadata: { name, description: "Research notes", llmSummary: null, tagsJson: "[]" }
  });
  mocks.list.mockReset()
    .mockResolvedValueOnce({ listings: [view("first", "First database")], nextCursor: "next" })
    .mockRejectedValueOnce(new Error("Temporary network failure"))
    .mockResolvedValueOnce({ listings: [view("second", "Second database")], nextCursor: null });
  render(<MarketplaceClient canisterId="aaaaa-aa" />);
  await screen.findByRole("heading", { name: "First database" });
  fireEvent.click(screen.getByRole("button", { name: "Load more" }));
  await screen.findByText("Temporary network failure");
  expect(screen.getByRole("heading", { name: "First database" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Load more" }));
  await screen.findByRole("heading", { name: "Second database" });
  expect(screen.getByRole("heading", { name: "First database" })).toBeTruthy();
  await waitFor(() => expect(screen.queryByText("Temporary network failure")).toBeNull());
  expect(mocks.list.mock.calls.map((call) => call[1])).toEqual([null, "next", "next"]);
});
