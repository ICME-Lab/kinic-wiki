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
async function connected() {
  await waitFor(() => expect(opener.postMessage).toHaveBeenCalled());
  act(() => incoming("ack"));
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Get transfer estimate" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
}
it("All requires full-balance consent; first execute only holds and final send waits for exact ready", async () => {
  mocks.actor.quote_vault_transfer.mockResolvedValue({ Ok: quoted });
  mocks.actor.execute_vault_transfer
    .mockResolvedValueOnce({ Ok: { ...quoted, phase: { Offered: null } } })
    .mockResolvedValueOnce({ Ok: { ...quoted, phase: { Paid: null } } });
  render(<VaultCreditClient canisterId="aaaaa-aa" />);
  await connected();
  fireEvent.click(screen.getByLabelText("All available credits"));
  fireEvent.click(
    screen.getByRole("button", { name: "Get transfer estimate" }),
  );
  await screen.findByText(/Estimated execution fee/);
  expect(
    screen
      .getByRole("button", { name: "Confirm and send" })
      .hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(
    screen.getByRole("button", { name: "Confirm and send" }),
  );
  await waitFor(() =>
    expect(mocks.actor.execute_vault_transfer).toHaveBeenCalledTimes(1),
  );
  expect(mocks.actor.execute_vault_transfer.mock.calls[0][1]).toEqual({
    AllAvailable: null,
  });
  // The single confirmation asks Vault for readiness without another click.
  await screen.findByText("Waiting for your Vault window…");
  await waitFor(() =>
    expect(
      opener.postMessage.mock.calls.some(([m]) => m.type === "offer"),
    ).toBe(true),
  );
  expect(
    screen.queryByRole("button", { name: "Request Vault readiness" }),
  ).toBeNull();
  act(() => incoming("ready", "02".repeat(16)));
  expect(mocks.actor.execute_vault_transfer).toHaveBeenCalledTimes(1);
  act(() => incoming("ready"));
  await screen.findByText("Paid");
  expect(mocks.actor.execute_vault_transfer).toHaveBeenCalledTimes(2);
  expect(mocks.actor.execute_vault_transfer.mock.calls[1][1]).toEqual({
    AllAvailable: null,
  });
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
it("late quote after same-Principal identity replacement cannot expose a confirmation", async () => {
  let resolve!: (v: unknown) => void;
  mocks.actor.quote_vault_transfer.mockReturnValue(
    new Promise((r) => (resolve = r)),
  );
  render(<VaultCreditClient canisterId="aaaaa-aa" />);
  await connected();
  fireEvent.click(
    screen.getByRole("button", { name: "Get transfer estimate" }),
  );
  (mocks.session.authClient as { getIdentity: () => unknown }).getIdentity =
    () => ({ getPrincipal: () => principal });
  await act(async () => resolve({ Ok: quoted }));
  expect(
    screen.queryByRole("button", { name: "Confirm and send" }),
  ).toBeNull();
});
it("an ambiguous hold error disables reserve and cancel until authenticated status refresh", async () => {
  mocks.actor.quote_vault_transfer.mockResolvedValue({
    Ok: { ...quoted, requested: { Exact: 90n } },
  });
  mocks.actor.execute_vault_transfer.mockRejectedValue(new Error("timeout"));
  render(<VaultCreditClient canisterId="aaaaa-aa" />);
  await connected();
  fireEvent.click(
    screen.getByRole("button", { name: "Get transfer estimate" }),
  );
  await screen.findByRole("button", { name: "Confirm and send" });
  fireEvent.click(
    screen.getByRole("button", { name: "Confirm and send" }),
  );
  await screen.findByText(/Request did not complete/);
  expect(
    screen
      .getByRole("button", { name: "Confirm and send" })
      .hasAttribute("disabled"),
  ).toBe(true);
  expect(
    screen
      .getByRole("button", { name: "Cancel unsent transfer" })
      .hasAttribute("disabled"),
  ).toBe(true);
  mocks.actor.get_vault_transfer.mockResolvedValue({
    Ok: { ...quoted, phase: { Unknown: null } },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Refresh transfer status" }),
  );
  await screen.findByText("Unknown");
  expect(
    screen.queryByRole("button", { name: "Cancel unsent transfer" }),
  ).toBeNull();
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
it("a standalone Wiki visit provides a top-level Vault link and never opens a Vault popup", async () => {
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
it("same-Principal reauthentication rejects a late ready notification", async () => {
  mocks.actor.get_pending_vault_transfer.mockResolvedValue({
    Ok: [{ ...quoted, phase: { Offered: null } }],
  });
  render(<VaultCreditClient canisterId="aaaaa-aa" />);
  await screen.findByText("Offered");
  act(() => incoming("ack"));
  fireEvent.click(
    screen.getByRole("button", { name: "Request Vault readiness" }),
  );
  const fresh = { getPrincipal: () => principal };
  (mocks.session.authClient as { getIdentity: () => unknown }).getIdentity =
    () => fresh;
  act(() => incoming("ready"));
  expect(
    screen.queryByRole("button", { name: "Send held credits" }),
  ).toBeNull();
  expect(mocks.actor.execute_vault_transfer).not.toHaveBeenCalled();
});
it("same-Principal reauthentication hides a late send result and sends no result message", async () => {
  const held = {
    ...quoted,
    requested: { Exact: 90n },
    phase: { Offered: null },
  };
  mocks.actor.get_pending_vault_transfer.mockResolvedValue({ Ok: [held] });
  let resolve!: (value: unknown) => void;
  mocks.actor.execute_vault_transfer.mockReturnValue(
    new Promise((r) => {
      resolve = r;
    }),
  );
  render(<VaultCreditClient canisterId="aaaaa-aa" />);
  await screen.findByText("Offered");
  act(() => incoming("ack"));
  fireEvent.click(
    screen.getByRole("button", { name: "Request Vault readiness" }),
  );
  act(() => incoming("ready"));
  fireEvent.click(screen.getByRole("button", { name: "Send held credits" }));
  const fresh = { getPrincipal: () => principal };
  (mocks.session.authClient as { getIdentity: () => unknown }).getIdentity =
    () => fresh;
  await act(async () => {
    resolve({ Ok: { ...held, phase: { Paid: null } } });
  });
  expect(screen.queryByText("Paid")).toBeNull();
  expect(
    opener.postMessage.mock.calls.filter(([m]) => m.type === "result"),
  ).toHaveLength(0);
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
it.each(["Paid", "Refunded"])(
  "%s requires a fresh Vault charge gesture, including after pending recovery is empty",
  async (phase) => {
    mocks.actor.get_pending_vault_transfer
      .mockResolvedValueOnce({ Ok: [{ ...quoted, phase: { [phase]: null } }] })
      .mockResolvedValue({ Ok: [] });
    render(<VaultCreditClient canisterId="aaaaa-aa" />);
    await screen.findByText(phase);
    act(() => incoming("ack"));
    expect(
      screen.queryByRole("button", { name: "Start another charge" }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Recover pending transfer" }),
    );
    await screen.findByText(/No pending transfer/);
    expect(
      screen.queryByRole("button", { name: "Get transfer estimate" }),
    ).toBeNull();
    expect(screen.getByText(/open a new Wiki window/)).toBeTruthy();
  },
);
it("Exact quote discloses bigint recipient credit, fee-inclusive source debit and remaining balance", async () => {
  mocks.actor.get_pending_vault_transfer.mockResolvedValue({
    Ok: [
      {
        ...quoted,
        requested: { Exact: 9007199254740993n },
        offer: { ...offer, amount_cycles: 9007199254740993n },
        balance_at_quote: 9007199254741093n,
        estimated_execution_fee_cycles: 7n,
      },
    ],
  });
  render(<VaultCreditClient canisterId="aaaaa-aa" />);
  await screen.findByText("Estimated remaining source balance: 93 cycles.");
  expect(
    screen.getByText(
      "Estimated recipient credit: 9,007,199,254,740,993 cycles.",
    ),
  ).toBeTruthy();
  expect(
    screen.getByText(
      "Estimated source reduction including execution fee: 9,007,199,254,741,000 cycles.",
    ),
  ).toBeTruthy();
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
it.each([
  ["Paid", "Quoted"],
  ["Paid", "Offered"],
  ["Refunded", "Quoted"],
  ["Refunded", "Offered"],
])(
  "%s A cannot adopt pending %s B; a fresh authenticated window can handle B",
  async (terminalPhase, pendingPhase) => {
    const a = {
      ...quoted,
      requested: { Exact: 90n },
      phase: { [terminalPhase]: null },
    };
    const b = {
      ...quoted,
      requested: { Exact: 90n },
      offer: { ...offer, operation: new Uint8Array(16).fill(2) },
      phase: { [pendingPhase]: null },
    };
    mocks.actor.get_pending_vault_transfer.mockResolvedValue({ Ok: [a] });
    const old = render(<VaultCreditClient canisterId="aaaaa-aa" />);
    await screen.findByText(terminalPhase);
    act(() => incoming("ack"));
    mocks.actor.get_pending_vault_transfer.mockResolvedValue({ Ok: [b] });
    fireEvent.click(
      screen.getByRole("button", { name: "Recover pending transfer" }),
    );
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Recover pending transfer" })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
    expect(screen.getByText(terminalPhase)).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Confirm and send" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Request Vault readiness" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Send held credits" }),
    ).toBeNull();
    expect(new URLSearchParams(window.location.hash.slice(1)).get("id")).toBe(
      id,
    );
    expect(mocks.actor.execute_vault_transfer).not.toHaveBeenCalled();
    old.unmount();
    const nextId = "03".repeat(16),
      nextNonce = "cd".repeat(32);
    window.history.replaceState(
      null,
      "",
      `/#mode=fund&id=${nextId}&nonce=${nextNonce}`,
    );
    opener = { postMessage: vi.fn(), closed: false };
    Object.defineProperty(window, "opener", {
      value: opener,
      configurable: true,
    });
    render(<VaultCreditClient canisterId="aaaaa-aa" />);
    await screen.findByText(pendingPhase);
    act(() =>
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: "https://vault.kinic.xyz",
          source: opener as unknown as Window,
          data: {
            protocol: "kinic-credit-v1",
            type: "ack",
            id: nextId,
            nonce: nextNonce,
          },
        }),
      ),
    );
    if (pendingPhase === "Quoted") {
      mocks.actor.execute_vault_transfer.mockResolvedValue({
        Ok: { ...b, phase: { Offered: null } },
      });
      fireEvent.click(
        screen.getByRole("button", { name: "Confirm and send" }),
      );
      await screen.findByText("Offered");
      expect(mocks.actor.execute_vault_transfer).toHaveBeenCalledWith(
        new Uint8Array(16).fill(2),
        { Exact: 90n },
      );
    }
    // A recovered Offered receipt asks explicitly; a fresh confirmation asks on its own.
    if (pendingPhase !== "Quoted")
      fireEvent.click(
        screen.getByRole("button", { name: "Request Vault readiness" }),
      );
    await waitFor(() =>
      expect(opener.postMessage).toHaveBeenCalledWith(
        {
          protocol: "kinic-credit-v1",
          type: "offer",
          id: "02".repeat(16),
          nonce: nextNonce,
        },
        "https://vault.kinic.xyz",
      ),
    );
  },
);
it.each(["Quoted", "Offered"])(
  "saved A wins on reload while another %s B is pending",
  async (pendingPhase) => {
    mocks.actor.get_vault_transfer.mockResolvedValue({
      Ok: { ...quoted, phase: { Paid: null } },
    });
    mocks.actor.get_pending_vault_transfer.mockResolvedValue({
      Ok: [
        {
          ...quoted,
          offer: { ...offer, operation: new Uint8Array(16).fill(2) },
          phase: { [pendingPhase]: null },
        },
      ],
    });
    render(<VaultCreditClient canisterId="aaaaa-aa" />);
    await screen.findByText("Paid");
    expect(new URLSearchParams(window.location.hash.slice(1)).get("id")).toBe(
      id,
    );
    expect(
      screen.queryByRole("button", { name: "Confirm and send" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Request Vault readiness" }),
    ).toBeNull();
    expect(mocks.actor.execute_vault_transfer).not.toHaveBeenCalled();
  },
);

it("does not replace a retired saved receipt with another tab's pending transfer", async () => {
  window.history.replaceState(
    null,
    "",
    `/#mode=fund&id=${id}&nonce=${nonce}&receipt=1`,
  );
  mocks.actor.get_pending_vault_transfer.mockResolvedValue({
    Ok: [
      {
        ...quoted,
        offer: { ...offer, operation: new Uint8Array(16).fill(2) },
        phase: { Offered: null },
      },
    ],
  });
  render(<VaultCreditClient canisterId="aaaaa-aa" />);
  await screen.findByText(/This channel has already reviewed a transfer/);
  incoming("ack");
  fireEvent.click(
    screen.getByRole("button", { name: "Recover pending transfer" }),
  );
  await screen.findByText(/Another transfer is pending/);
  expect(new URLSearchParams(window.location.hash.slice(1)).get("id")).toBe(id);
  expect(
    screen.queryByRole("button", { name: "Confirm and send" }),
  ).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Request Vault readiness" }),
  ).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Get transfer estimate" }),
  ).toBeNull();
  expect(mocks.actor.execute_vault_transfer).not.toHaveBeenCalled();
});

it.each(["marked", "retired marked", "unmarked"])(
  "%s A cannot be overtaken by pending B during link or saved-receipt initialization",
  async (kind) => {
    let releaseLink!: (value: unknown) => void;
    let releaseSaved!: (value: unknown) => void;
    mocks.actor.get_vault_link.mockReturnValue(
      new Promise((resolve) => {
        releaseLink = resolve;
      }),
    );
    mocks.actor.get_vault_transfer.mockReturnValue(
      new Promise((resolve) => {
        releaseSaved = resolve;
      }),
    );
    mocks.actor.get_pending_vault_transfer.mockResolvedValue({
      Ok: [
        {
          ...quoted,
          requested: { Exact: 90n },
          offer: { ...offer, operation: new Uint8Array(16).fill(2) },
        },
      ],
    });
    const savedURL = `/#mode=fund&id=${id}&nonce=${nonce}${kind === "unmarked" ? "" : "&receipt=1"}`;
    window.history.replaceState(null, "", savedURL);
    render(<VaultCreditClient canisterId="aaaaa-aa" />);
    await waitFor(() => expect(mocks.actor.get_vault_link).toHaveBeenCalled());
    act(() => incoming("ack"));
    const assertBlocked = () => {
      const recover = screen.getByRole("button", {
        name: "Recover pending transfer",
      });
      expect(recover.hasAttribute("disabled")).toBe(true);
      fireEvent.click(recover);
      expect(mocks.actor.get_pending_vault_transfer).not.toHaveBeenCalled();
      expect(window.location.pathname + window.location.hash).toBe(savedURL);
      for (const name of [
        "Confirm and send",
        "Request Vault readiness",
        "Send held credits",
      ])
        expect(screen.queryByRole("button", { name })).toBeNull();
      expect(mocks.actor.execute_vault_transfer).not.toHaveBeenCalled();
    };
    assertBlocked();
    await act(async () =>
      releaseLink({
        Ok: [
          {
            wiki_owner: principal,
            vault_owner: principal,
            generation: 1n,
            active: true,
          },
        ],
      }),
    );
    await waitFor(() =>
      expect(mocks.actor.get_vault_transfer).toHaveBeenCalled(),
    );
    assertBlocked();
    await act(async () =>
      releaseSaved(
        kind === "retired marked"
          ? { Err: { NotFound: null } }
          : { Ok: { ...quoted, phase: { Paid: null } } },
      ),
    );
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Recover pending transfer" })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Recover pending transfer" }),
    );
    await screen.findByText(/Another transfer is pending/);
    expect(new URLSearchParams(window.location.hash.slice(1)).get("id")).toBe(
      id,
    );
    expect(
      screen.queryByRole("button", { name: "Confirm and send" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Request Vault readiness" }),
    ).toBeNull();
    expect(mocks.actor.execute_vault_transfer).not.toHaveBeenCalled();
    if (kind !== "retired marked")
      expect(screen.getByText("Paid")).toBeTruthy();
  },
);

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
it("a failed automatic send stops and never retries without the user", async () => {
  mocks.actor.quote_vault_transfer.mockResolvedValue({
    Ok: { ...quoted, requested: { Exact: 90n } },
  });
  mocks.actor.execute_vault_transfer
    .mockResolvedValueOnce({
      Ok: { ...quoted, requested: { Exact: 90n }, phase: { Offered: null } },
    })
    .mockRejectedValueOnce(new Error("lost reply"));
  render(<VaultCreditClient canisterId="aaaaa-aa" />);
  await connected();
  fireEvent.click(
    screen.getByRole("button", { name: "Get transfer estimate" }),
  );
  await screen.findByText("Quoted");
  fireEvent.click(screen.getByRole("button", { name: "Confirm and send" }));
  await screen.findByText("Waiting for your Vault window…");
  act(() => incoming("ready"));
  await screen.findByText(/Request did not complete/);
  act(() => incoming("ready"));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(mocks.actor.execute_vault_transfer).toHaveBeenCalledTimes(2);
  expect(screen.queryByText("Waiting for your Vault window…")).toBeNull();
});
