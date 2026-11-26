// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { WikiBridgeActor } from "@kinic/credit-bridge-candid";
import { AutoTopupPanel, parseBillions } from "./auto-topup-panel";

afterEach(cleanup);
const databases = [
  { databaseId: "db1", name: "Research" },
  { databaseId: "db2", name: "Team" },
];
function actor(initial: unknown[] = []) {
  const set = vi.fn(async (arg: unknown[]) => ({
    Ok: arg.length
      ? [{ policy: arg[0], database_name: "Team", sent_today_cycles: 0n, last_topup_at_ns: [] }]
      : [],
  }));
  return {
    actor: {
      get_vault_auto_topup: vi.fn(async () => ({ Ok: initial })),
      set_vault_auto_topup: set,
    } as unknown as WikiBridgeActor,
    set,
  };
}

it("parses billions of cycles exactly", () => {
  expect(parseBillions("12.5")).toBe(12_500_000_000n);
  expect(parseBillions("0.000000001")).toBe(1n);
  expect(parseBillions("1.0000000001")).toBeNull();
  expect(parseBillions("-1")).toBeNull();
});

it("turns on a bounded refill policy for the chosen database", async () => {
  const { actor: a, set } = actor();
  render(<AutoTopupPanel actor={a} databases={databases} disabled={false} />);
  fireEvent.click(await screen.findByRole("button", { name: "Turn on auto top-up" }));
  fireEvent.change(screen.getByLabelText("Pay from database"), { target: { value: "db2" } });
  fireEvent.change(screen.getByLabelText("Add each time"), { target: { value: "250" } });
  // A daily limit below one refill cannot be saved.
  expect((screen.getByRole("button", { name: "Save auto top-up" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("At most per day"), { target: { value: "500" } });
  fireEvent.click(screen.getByRole("button", { name: "Save auto top-up" }));
  await screen.findByText("Auto top-up saved.");
  expect(set).toHaveBeenCalledWith([
    {
      database_id: "db2",
      threshold_cycles: 10_000_000_000n,
      amount_cycles: 250_000_000_000n,
      daily_limit_cycles: 500_000_000_000n,
      min_database_cycles: 100_000_000_000n,
    },
  ]);
  expect(screen.getByText("On")).toBeTruthy();
});

it("turns an existing policy off", async () => {
  const { actor: a, set } = actor([
    {
      policy: {
        database_id: "db1",
        threshold_cycles: 1n,
        amount_cycles: 2n,
        daily_limit_cycles: 2n,
        min_database_cycles: 0n,
      },
      database_name: "Research",
      sent_today_cycles: 0n,
      last_topup_at_ns: [],
    },
  ]);
  render(<AutoTopupPanel actor={a} databases={databases} disabled={false} />);
  fireEvent.click(await screen.findByRole("button", { name: "Turn off" }));
  await waitFor(() => expect(set).toHaveBeenCalledWith([]));
  await screen.findByText("Auto top-up turned off.");
});
