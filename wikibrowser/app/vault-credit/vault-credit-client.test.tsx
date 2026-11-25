// @vitest-environment jsdom
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
  act,
} from "@testing-library/react";
import { afterEach, beforeEach, it, expect, vi } from "vitest";
import { Principal } from "@icp-sdk/core/principal";
import type { VaultTransfer } from "@kinic/credit-bridge-candid";
const mocks = vi.hoisted(() => ({
  session: {} as Record<string, unknown>,
  actor: {
    get_vault_link: vi.fn(),
    preview_vault_link: vi.fn(),
    approve_vault_link: vi.fn(),
    get_pending_vault_transfer: vi.fn(),
    get_vault_transfer: vi.fn(),
    quote_vault_transfer: vi.fn(),
    execute_vault_transfer: vi.fn(),
    reconcile_vault_transfer: vi.fn(),
    cancel_vault_transfer: vi.fn(),
    get_vault_auto_topup: vi.fn(),
    set_vault_auto_topup: vi.fn(),
  },
  databases: vi.fn(),
}));
vi.mock("@/app/app-session-provider", () => ({
  useAppSession: () => mocks.session,
}));
vi.mock("@/lib/vault-credit", () => ({
  wikiCreditActor: async () => mocks.actor,
  creditOrigins: () => ({
    wiki: "https://wiki.kinic.xyz",
    vault: "https://vault.kinic.xyz",
  }),
  ownerDatabases: mocks.databases,
}));
import { VaultCreditClient } from "./vault-credit-client";
const principal = Principal.fromText("aaaaa-aa"),
  id = "01".repeat(16),
  nonce = "ab".repeat(32);
const offer = {
  operation: new Uint8Array(16).fill(1),
  wiki_owner: principal,
  vault_owner: principal,
  link_generation: 1n,
  amount_cycles: 90n,
  expires_at_ns: BigInt(Date.now() + 300000) * 1000000n,
};
const quoted: VaultTransfer = {
  offer,
  requested: { All: null },
  database_id: "db1",
  phase: { Quoted: null },
  balance_at_quote: 100n,
  estimated_execution_fee_cycles: 10n,
  collected_execution_fee_cycles: 0n,
  receiver_cleanup_pending: false,
};
let opener: { postMessage: ReturnType<typeof vi.fn>; closed: boolean };
const incoming = (type: string, op = id) =>
  window.dispatchEvent(
    new MessageEvent("message", {
      origin: "https://vault.kinic.xyz",
      source: opener as unknown as Window,
      data: { protocol: "kinic-credit-v1", type, id: op, nonce },
    }),
  );
beforeEach(() => {
  vi.clearAllMocks();
  const identity = { getPrincipal: () => principal };
  mocks.session = {
    authClient: { getIdentity: () => identity },
    principal: principal.toText(),
    authLoading: false,
    login: vi.fn(),
  };
  mocks.actor.get_vault_link.mockResolvedValue({
    Ok: [
      {
        wiki_owner: principal,
        vault_owner: principal,
        generation: 1n,
        active: true,
      },
    ],
  });
  mocks.actor.get_vault_transfer.mockResolvedValue({ Err: { NotFound: null } });
  mocks.actor.get_vault_auto_topup.mockResolvedValue({ Ok: [] });
  mocks.actor.get_pending_vault_transfer.mockResolvedValue({ Ok: [] });
  mocks.databases.mockResolvedValue([
    { databaseId: "db1", name: "Research", cyclesBalance: "100" },
  ]);
  opener = { postMessage: vi.fn(), closed: false };
  Object.defineProperty(window, "opener", {
    value: opener,
    configurable: true,
  });
  window.history.replaceState(null, "", `/#mode=fund&id=${id}&nonce=${nonce}`);
});
afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});
it("Unknown recovered from backend exposes reconciliation and no cancel or resend", async () => {
  mocks.actor.get_pending_vault_transfer.mockResolvedValue({
    Ok: [{ ...quoted, phase: { Unknown: null } }],
  });
  render(<VaultCreditClient canisterId="aaaaa-aa" />);
  await screen.findByText("Unknown");
  expect(
    screen.queryByRole("button", { name: "Cancel unsent transfer" }),
  ).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Send held credits" }),
  ).toBeNull();
  expect(
    screen.getByRole("button", { name: "Reconcile transfer" }),
  ).toBeTruthy();
  expect(mocks.actor.execute_vault_transfer).not.toHaveBeenCalled();
});
it("recovers a handoff quote by ID when original-payer pending is empty", async () => {
  mocks.actor.get_vault_transfer.mockResolvedValue({ Ok: quoted });
  render(<VaultCreditClient canisterId="aaaaa-aa" />);
  await screen.findByText("Quoted");
  expect(mocks.actor.get_vault_transfer).toHaveBeenCalledWith(
    new Uint8Array(16).fill(1),
  );
  expect(mocks.actor.execute_vault_transfer).not.toHaveBeenCalled();
});
it("a standalone Wiki visit without a link provides a top-level Vault link and never opens a Vault popup", async () => {
  mocks.actor.get_vault_link.mockResolvedValue({ Ok: [] });
  Object.defineProperty(window, "opener", { value: null, configurable: true });
  window.history.replaceState(null, "", "/");
  const open = vi.spyOn(window, "open");
  render(<VaultCreditClient canisterId="aaaaa-aa" />);
  const link = await screen.findByRole("link", { name: "Continue in Vault" });
  expect(link.getAttribute("target")).toBe("_self");
  expect(link.getAttribute("href")).toMatch(
    /^https:\/\/vault.kinic.xyz\/#mode=fund&id=/,
  );
  expect(open).not.toHaveBeenCalled();
  open.mockRestore();
});
it("closing the Vault window keeps authenticated Unknown reconciliation available", async () => {
  mocks.actor.get_pending_vault_transfer.mockResolvedValue({
    Ok: [{ ...quoted, phase: { Unknown: null } }],
  });
  render(<VaultCreditClient canisterId="aaaaa-aa" />);
  await screen.findByText("Unknown");
  opener.closed = true;
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 550));
  });
  expect(screen.getByText("Unknown")).toBeTruthy();
  expect(
    screen
      .getByRole("button", { name: "Reconcile transfer" })
      .hasAttribute("disabled"),
  ).toBe(false);
});
it("link-only popup cannot quote or hold even after explicit link approval", async () => {
  window.history.replaceState(null, "", `/#mode=link&id=${id}&nonce=${nonce}`);
  mocks.actor.preview_vault_link.mockResolvedValue({
    Ok: {
      challenge: offer.operation,
      vault_owner: principal,
      generation: 1n,
      expires_at_ns: offer.expires_at_ns,
    },
  });
  mocks.actor.approve_vault_link.mockResolvedValue({
    Ok: {
      wiki_owner: principal,
      vault_owner: principal,
      generation: 1n,
      active: true,
    },
  });
  render(<VaultCreditClient canisterId="aaaaa-aa" />);
  await screen.findByRole("button", { name: "Approve account link" });
  act(() => incoming("ack"));
  fireEvent.click(screen.getByRole("button", { name: "Approve account link" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Approve account link" }),
    ).toBeNull(),
  );
  expect(
    screen.queryByRole("button", { name: "Get transfer estimate" }),
  ).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Confirm and send" }),
  ).toBeNull();
  expect(mocks.actor.execute_vault_transfer).not.toHaveBeenCalled();
});
it("the opaque receipt ID stays in the fragment so reload cannot turn a used channel into a new quote", async () => {
  mocks.actor.get_pending_vault_transfer.mockResolvedValue({
    Ok: [
      {
        ...quoted,
        offer: { ...offer, operation: new Uint8Array(16).fill(9) },
        phase: { Paid: null },
      },
    ],
  });
  render(<VaultCreditClient canisterId="aaaaa-aa" />);
  await screen.findByText("Paid");
  expect(new URLSearchParams(window.location.hash.slice(1)).get("id")).toBe(
    "09".repeat(16),
  );
  expect(new URLSearchParams(window.location.hash.slice(1)).get("nonce")).toBe(
    nonce,
  );
  expect(
    new URLSearchParams(window.location.hash.slice(1)).get("receipt"),
  ).toBe("1");
});
it.each(["Quoted", "Offered"])(
  "a late initialization failure leaves %s data non-actionable",
  async (phase) => {
    let rejectDatabases!: (error: Error) => void;
    mocks.databases.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectDatabases = reject;
      }),
    );
    mocks.actor.get_vault_transfer.mockResolvedValue({
      Ok: { ...quoted, requested: { Exact: 90n }, phase: { [phase]: null } },
    });
    render(<VaultCreditClient canisterId="aaaaa-aa" />);
    await waitFor(() => expect(mocks.databases).toHaveBeenCalled());
    act(() => incoming("ack"));
    const assertBlocked = () => {
      for (const name of [
        "Recover pending transfer",
        "Confirm and send",
        "Request Vault readiness",
        "Revoke account link",
        "Refresh transfer status",
        "Reconcile transfer",
        "Cancel unsent transfer",
      ]) {
        const button = screen.queryByRole("button", { name });
        if (button) {
          expect(button.hasAttribute("disabled")).toBe(true);
          fireEvent.click(button);
        }
      }
      expect(mocks.actor.execute_vault_transfer).not.toHaveBeenCalled();
      expect(mocks.actor.cancel_vault_transfer).not.toHaveBeenCalled();
      expect(mocks.actor.reconcile_vault_transfer).not.toHaveBeenCalled();
      expect(
        opener.postMessage.mock.calls.some(([m]) => m.type === "offer"),
      ).toBe(false);
    };
    assertBlocked();
    await act(async () =>
      rejectDatabases(Error("database lookup unavailable")),
    );
    await screen.findByText(
      "Could not load credit bridge status. Reload to recover before starting a transfer.",
    );
    assertBlocked();
  },
);

it("completed initialization still permits authenticated Unknown status and reconciliation without an opener", async () => {
  Object.defineProperty(window, "opener", { value: null, configurable: true });
  mocks.actor.get_vault_transfer.mockResolvedValue({
    Ok: { ...quoted, phase: { Unknown: null } },
  });
  mocks.actor.reconcile_vault_transfer.mockResolvedValue({
    Ok: { ...quoted, phase: { Paid: null } },
  });
  render(<VaultCreditClient canisterId="aaaaa-aa" />);
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Refresh transfer status" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Refresh transfer status" }),
  );
  await waitFor(() =>
    expect(mocks.actor.get_vault_transfer).toHaveBeenCalledTimes(2),
  );
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Reconcile transfer" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Reconcile transfer" }));
  await screen.findByText("Paid");
  expect(mocks.actor.reconcile_vault_transfer).toHaveBeenCalledWith(
    new Uint8Array(16).fill(1),
  );
  expect(mocks.actor.execute_vault_transfer).not.toHaveBeenCalled();
  expect(mocks.actor.cancel_vault_transfer).not.toHaveBeenCalled();
  expect(opener.postMessage).not.toHaveBeenCalled();
});
it("shows a held refill for recovery and lets the owner cancel it", async () => {
  mocks.actor.get_pending_vault_transfer.mockResolvedValue({
    Ok: [{ ...quoted, requested: { Exact: 90n }, phase: { Offered: null } }],
  });
  mocks.actor.cancel_vault_transfer.mockResolvedValue({
    Ok: { ...quoted, requested: { Exact: 90n }, phase: { Refunded: null } },
  });
  mocks.actor.reconcile_vault_transfer.mockResolvedValue({
    Ok: { ...quoted, requested: { Exact: 90n }, phase: { Refunded: null } },
  });
  render(<VaultCreditClient canisterId="aaaaa-aa" />);
  await screen.findByText("Offered");
  expect(screen.getByRole("region", { name: "Transfer to Vault" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Get transfer estimate" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Cancel unsent transfer" }));
  await screen.findByText("Refunded");
  await screen.findByText(/This transfer is finished/);
});
