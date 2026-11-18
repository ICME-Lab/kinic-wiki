// @vitest-environment jsdom
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { it, expect, vi, afterEach } from "vitest";
import { Principal } from "@icp-sdk/core/principal";
import type { VaultClient } from "@kinic/vault-client";
import type {
  Payment,
  ReconciliationProgress,
} from "@kinic/vault-client/contracts";
const mocks = vi.hoisted(() => ({
  mode: "synthetic-test-only",
  approve: vi.fn(),
  agent: vi.fn(),
}));
vi.mock("@icp-sdk/core/agent", () => ({
  Actor: {
    createActor: () => ({
      icrc2_approve: mocks.approve,
    }),
  },
  HttpAgent: {
    createSync: mocks.agent,
  },
}));
vi.mock("./config", () => ({
  loadConfig: async () => ({
    canister: "aaaaa-aa",
    host: "https://icp0.io",
    local: false,
    fundingMode: mocks.mode,
  }),
}));
import { Funding } from "./funding";
afterEach(() => {
  cleanup();
  mocks.mode = "synthetic-test-only";
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
const createdAtNs = BigInt(Date.now()) * 1_000_000n;
const payment: Payment = {
  preparing: false,
  reconciliation: [],
  wallet: Principal.fromText("aaaaa-aa"),
  request: {
    operation: new Uint8Array(16).fill(4),
    beneficiary: Principal.fromText("aaaaa-aa"),
    amount_e8s: 100_000_000n,
    min_credits: 20_000_000n,
    created_at_time: createdAtNs,
  },
  config: {
    ledger: Principal.fromText("aaaaa-aa"),
    recipient: Principal.fromText("aaaaa-aa"),
    cycles_per_kinic: 100_000_000n,
  },
  fee: 10n,
  credits: 100_000_000n,
  memo: new Uint8Array(32).fill(3),
  created_at_time: createdAtNs,
  status: {
    Unknown: null,
  },
  generation: 1n,
  attempt: 1n,
  sent_at: 100n,
  uncertain: true,
};
const quotedPayment: Payment = {
  ...payment,
  status: { Quoted: null },
  attempt: 0n,
  sent_at: 0n,
  uncertain: false,
};
function client(p: Payment = payment) {
  return {
    identity: {
      getPrincipal: () => p.wallet,
    },
    session: {
      capture: () => 0,
    },
    actor: {
      list_payments: vi.fn(async () => ({
        Ok: [p],
      })),
      pay_purchase: vi.fn(async () => ({
        Ok: p,
      })),
      quote_purchase: vi.fn(),
      cancel_quote: vi.fn(async () => ({
        Ok: { ...p, status: { Expired: null } },
      })),
      payment_status: vi.fn(async () => ({
        Ok: [p],
      })),
    },
  } as unknown as VaultClient;
}
it("recovers unknown payment and retries only its stored operation without new approval or new quote", async () => {
  const c = client();
  render(<Funding client={c} onFunded={async () => {}} />);
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Retry same payment",
    }),
  );
  await waitFor(() =>
    expect(c.actor.pay_purchase).toHaveBeenCalledWith(
      payment.request.operation,
    ),
  );
  expect(mocks.approve).not.toHaveBeenCalled();
  expect(c.actor.quote_purchase).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("button", {
      name: "New quote",
    }),
  ).toBeNull();
});
it("pins approval amount, expiry, memo and timestamp and accepts its Duplicate before the exact purchase", async () => {
  const p = {
    ...payment,
    status: {
      Quoted: null,
    },
    uncertain: false,
  } as Payment;
  const c = client(p);
  mocks.approve.mockResolvedValue({
    Err: {
      Duplicate: {
        duplicate_of: 8n,
      },
    },
  });
  render(<Funding client={c} onFunded={async () => {}} />);
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Approve and pay this quote",
    }),
  );
  await waitFor(() =>
    expect(c.actor.pay_purchase).toHaveBeenCalledWith(p.request.operation),
  );
  expect(mocks.approve).toHaveBeenCalledWith(
    expect.objectContaining({
      amount: 100_000_010n,
      fee: [10n],
      memo: [p.memo],
      created_at_time: [createdAtNs],
      expires_at: [createdAtNs + 300_000_000_000n],
    }),
  );
  expect(mocks.agent).toHaveBeenCalledWith({
    host: "https://icp0.io",
    identity: c.identity,
  });
});
it("does not permit a replacement payment while history is unavailable", async () => {
  const c = client();
  vi.mocked(c.actor.list_payments).mockRejectedValue(Error("offline"));
  render(<Funding client={c} onFunded={async () => {}} />);
  await screen.findByRole("alert");
  expect(
    (
      screen.getByRole("button", {
        name: "Get quote",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(c.actor.quote_purchase).not.toHaveBeenCalled();
});
it("keeps a lost payment reply unresolved without another approval or payment", async () => {
  const c = client(quotedPayment);
  mocks.approve.mockResolvedValue({ Ok: 8n });
  vi.mocked(c.actor.pay_purchase).mockRejectedValueOnce(Error("offline: private payload"));
  render(<Funding client={c} onFunded={async () => {}} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Approve and pay this quote" }),
  );
  expect((await screen.findByRole("alert")).textContent).toMatch(/Payment outcome is unknown/);
  expect(screen.queryByText(/private payload/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Check payment status" }));
  await screen.findByText(/Status check complete: Awaiting approval/);
  expect(screen.queryByRole("button", { name: /Pay approved quote|Approve and pay|Retry same|New quote|Cancel unpaid/ })).toBeNull();
  expect(mocks.approve).toHaveBeenCalledTimes(1);
  expect(c.actor.pay_purchase).toHaveBeenCalledTimes(1);
  expect(c.actor.quote_purchase).not.toHaveBeenCalled();
});

it("restores the approved payment after Busy and an authenticated unsubmitted status", async () => {
  const c = client(quotedPayment);
  mocks.approve.mockResolvedValue({ Ok: 8n });
  vi.mocked(c.actor.pay_purchase)
    .mockResolvedValueOnce({ Err: { Busy: null } })
    .mockResolvedValueOnce({ Ok: { ...quotedPayment, status: { Paid: 123n } } });
  render(<Funding client={c} onFunded={async () => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "Approve and pay this quote" }));
  expect((await screen.findByRole("alert")).textContent).toMatch(/Payment failed.*temporarily unavailable/);
  expect(screen.queryByRole("button", { name: "Pay approved quote" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Check payment status" }));
  await screen.findByText("Status check complete: Awaiting approval.");
  expect(c.actor.pay_purchase).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Pay approved quote" }));
  await screen.findByText("Paid");
  expect(c.actor.pay_purchase).toHaveBeenNthCalledWith(2, quotedPayment.request.operation);
  expect(mocks.approve).toHaveBeenCalledTimes(1);
  expect(c.actor.quote_purchase).not.toHaveBeenCalled();
});

it("preserves a storage failure while keeping the payment unresolved", async () => {
  const c = client(quotedPayment);
  mocks.approve.mockResolvedValue({ Ok: 8n });
  vi.mocked(c.actor.pay_purchase).mockResolvedValueOnce({ Err: { Storage: null } });
  render(<Funding client={c} onFunded={async () => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "Approve and pay this quote" }));
  const storageFailure = /Payment outcome is unknown.*payment record could not be saved or read/;
  expect((await screen.findByRole("alert")).textContent).toMatch(storageFailure);
  vi.mocked(c.actor.payment_status).mockResolvedValue({ Ok: [payment] });
  fireEvent.click(screen.getByRole("button", { name: "Check payment status" }));
  await screen.findByText("Status check complete: Needs status check.");
  expect(screen.getByRole("alert").textContent).toMatch(storageFailure);
  expect(screen.queryByRole("button", { name: /Pay approved quote|Approve and pay|Retry same|New quote|Cancel unpaid/ })).toBeNull();
  expect(mocks.approve).toHaveBeenCalledTimes(1);
  expect(c.actor.pay_purchase).toHaveBeenCalledTimes(1);
  expect(c.actor.quote_purchase).not.toHaveBeenCalled();
});

it("keeps explicit same-operation recovery for an authenticated Unknown response", async () => {
  const c = client(quotedPayment);
  mocks.approve.mockResolvedValue({ Ok: 8n });
  vi.mocked(c.actor.pay_purchase)
    .mockResolvedValueOnce({ Ok: payment })
    .mockResolvedValueOnce({ Ok: { ...payment, status: { Paid: 123n } } });
  render(<Funding client={c} onFunded={async () => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "Approve and pay this quote" }));
  const retry = await screen.findByRole("button", { name: "Retry same payment" });
  expect(c.actor.pay_purchase).toHaveBeenCalledTimes(1);
  fireEvent.click(retry);
  await screen.findByText("Paid");
  expect(c.actor.pay_purchase).toHaveBeenNthCalledWith(2, quotedPayment.request.operation);
  expect(mocks.approve).toHaveBeenCalledTimes(1);
  expect(c.actor.quote_purchase).not.toHaveBeenCalled();
});

it("shows the approval stage while the ledger response is pending", async () => {
  const c = client(quotedPayment);
  mocks.approve.mockReturnValue(new Promise(() => {}));
  render(<Funding client={c} onFunded={async () => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "Approve and pay this quote" }));
  const progress = await screen.findByRole("status", { name: "Payment progress" });
  await waitFor(() => expect(progress.textContent).toBe("Approving"));
  expect(c.actor.pay_purchase).not.toHaveBeenCalled();
});

it("reports an acknowledged approval followed by a structured payment expiry", async () => {
  const c = client(quotedPayment);
  mocks.approve.mockResolvedValue({ Ok: 8n });
  vi.mocked(c.actor.pay_purchase).mockResolvedValue({ Err: { Expired: null } });
  render(<Funding client={c} onFunded={async () => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "Approve and pay this quote" }));
  expect((await screen.findByRole("alert")).textContent).toMatch(/Payment failed.*expired/i);
  expect(screen.queryByRole("button", { name: "Pay approved quote" })).toBeNull();
  expect(mocks.approve).toHaveBeenCalledTimes(1);
  expect(c.actor.pay_purchase).toHaveBeenCalledTimes(1);
  expect(c.actor.quote_purchase).not.toHaveBeenCalled();
});

it("reports the completion of an unchanged Quoted status check", async () => {
  const c = client(quotedPayment);
  render(<Funding client={c} onFunded={async () => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "Check payment status" }));
  const progress = await screen.findByRole("status", { name: "Payment progress" });
  await waitFor(() => expect(progress.textContent).toBe("Status check complete: Awaiting approval."));
  expect(mocks.approve).not.toHaveBeenCalled();
  expect(c.actor.pay_purchase).not.toHaveBeenCalled();
});

it("shows the completed Quoted check when balance refresh fails", async () => {
  const c = client(quotedPayment);
  const onFunded = vi.fn().mockRejectedValue(Error("balance service is offline"));
  render(<Funding client={c} onFunded={onFunded} />);
  fireEvent.click(await screen.findByRole("button", { name: "Check payment status" }));
  await screen.findByText("Status check complete: Awaiting approval.");
  expect((await screen.findByRole("alert")).textContent).toMatch(/Balance could not be updated/);
  expect(mocks.approve).not.toHaveBeenCalled();
  expect(c.actor.pay_purchase).not.toHaveBeenCalled();
});

it("clears the unknown outcome when a check returns Paid and balance refresh fails", async () => {
  const c = client(quotedPayment);
  const onFunded = vi.fn().mockRejectedValue(Error("balance service is offline"));
  mocks.approve.mockResolvedValue({ Ok: 8n });
  vi.mocked(c.actor.pay_purchase).mockRejectedValueOnce(Error("lost reply"));
  render(<Funding client={c} onFunded={onFunded} />);
  fireEvent.click(await screen.findByRole("button", { name: "Approve and pay this quote" }));
  expect((await screen.findByRole("alert")).textContent).toMatch(/Payment outcome is unknown/);
  vi.mocked(c.actor.payment_status).mockResolvedValue({
    Ok: [{ ...quotedPayment, status: { Paid: 123n } }],
  });
  fireEvent.click(screen.getByRole("button", { name: "Check payment status" }));
  await screen.findByText("Status check complete: Paid.");
  expect((await screen.findByRole("alert")).textContent).toBe("Balance could not be updated.");
  expect(c.actor.pay_purchase).toHaveBeenCalledTimes(1);
});

it("shows how to correct the amount before requesting a quote", async () => {
  const c = client(quotedPayment);
  vi.mocked(c.actor.list_payments).mockResolvedValue({ Ok: [] });
  render(<Funding client={c} onFunded={async () => {}} />);
  const quote = await screen.findByRole<HTMLButtonElement>("button", { name: "Get quote" });
  await waitFor(() => expect(quote.disabled).toBe(false));
  fireEvent.change(screen.getByRole("textbox", { name: "KINIC amount" }), {
    target: { value: "0.000000001" },
  });
  fireEvent.click(quote);
  expect((await screen.findByRole("alert")).textContent).toMatch(/positive KINIC amount.*8 decimal places/);
  expect(c.actor.quote_purchase).not.toHaveBeenCalled();
});

it.each([
  ["payment_status", "Check payment status"],
  ["cancel_quote", "Cancel unpaid quote"],
] as const)("preserves a known error returned by %s", async (method, button) => {
  const c = client(quotedPayment);
  vi.mocked(c.actor[method]).mockResolvedValue({ Err: { Storage: null } });
  render(<Funding client={c} onFunded={async () => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: button }));
  expect((await screen.findByRole("alert")).textContent).toMatch(/payment record could not be saved or read/);
  expect(c.actor.pay_purchase).not.toHaveBeenCalled();
});

it("reports a rejected status check while keeping the original payment unresolved", async () => {
  const c = client(quotedPayment);
  mocks.approve.mockResolvedValue({ Ok: 8n });
  vi.mocked(c.actor.pay_purchase).mockRejectedValueOnce(Error("lost reply"));
  render(<Funding client={c} onFunded={async () => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "Approve and pay this quote" }));
  await screen.findByRole("alert");
  vi.mocked(c.actor.payment_status).mockResolvedValue({ Err: { Storage: null } });
  fireEvent.click(screen.getByRole("button", { name: "Check payment status" }));
  const failure = await screen.findByRole("alert");
  expect(failure.textContent).toMatch(/Status check failed.*payment record could not be saved or read/);
  expect(failure.textContent).toMatch(/Payment outcome is unknown/);
  expect(c.actor.pay_purchase).toHaveBeenCalledTimes(1);
});

it("offers explicit re-preparation of an expired unsubmitted quote without charging approval", async () => {
  const c = client(quotedPayment);
  vi.spyOn(Date, "now").mockReturnValue(Number(createdAtNs / 1_000_000n) + 300_001);
  render(<Funding client={c} onFunded={async () => {}} />);
  const prepare = await screen.findByRole("button", { name: "Prepare a new quote" });
  expect(screen.getByText(/quote has expired/i)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Approve and pay this quote" })).toBeNull();
  fireEvent.click(prepare);
  await screen.findByRole("button", { name: "Get quote" });
  expect(c.actor.cancel_quote).toHaveBeenCalledWith(quotedPayment.request.operation);
  expect(mocks.approve).not.toHaveBeenCalled();
  expect(c.actor.pay_purchase).not.toHaveBeenCalled();
  expect(c.actor.quote_purchase).not.toHaveBeenCalled();
});

it("revalidates an approval that returns after the quote expires", async () => {
  const c = client(quotedPayment);
  const now = vi.spyOn(Date, "now").mockReturnValue(Number(createdAtNs / 1_000_000n));
  let resolve!: (value: unknown) => void;
  mocks.approve.mockImplementation(() => new Promise((done) => { resolve = done; }));
  render(<Funding client={c} onFunded={async () => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "Approve and pay this quote" }));
  await waitFor(() => expect(mocks.approve).toHaveBeenCalledTimes(1));
  now.mockReturnValue(Number(createdAtNs / 1_000_000n) + 300_001);
  resolve({ Ok: 8n });
  expect((await screen.findByRole("alert")).textContent).toMatch(/expired/i);
  expect(c.actor.pay_purchase).not.toHaveBeenCalled();
  expect(c.actor.quote_purchase).not.toHaveBeenCalled();
});

it("requires another confirmation if the same operation has different authoritative terms", async () => {
  const c = client(quotedPayment);
  mocks.approve.mockResolvedValue({ Ok: 8n });
  vi.mocked(c.actor.payment_status).mockResolvedValue({
    Ok: [{ ...quotedPayment, fee: 20n }],
  });
  render(<Funding client={c} onFunded={async () => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "Approve and pay this quote" }));
  expect((await screen.findByRole("alert")).textContent).toMatch(/terms changed/i);
  expect(mocks.approve).not.toHaveBeenCalled();
  expect(c.actor.pay_purchase).not.toHaveBeenCalled();
});

it("keeps an ambiguous approval from being repeated after a read-only status check", async () => {
  const c = client(quotedPayment);
  mocks.approve.mockRejectedValueOnce(Error("offline"));
  render(<Funding client={c} onFunded={async () => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "Approve and pay this quote" }));
  expect((await screen.findByRole("alert")).textContent).toMatch(/Approval outcome is unknown/);
  fireEvent.click(screen.getByRole("button", { name: "Check payment status" }));
  await screen.findByText(/Status check complete: Awaiting approval/);
  expect(screen.queryByRole("button", { name: /Pay approved quote|Approve and pay/ })).toBeNull();
  expect(mocks.approve).toHaveBeenCalledTimes(1);
  expect(c.actor.pay_purchase).not.toHaveBeenCalled();
});
it("recovers a lost approval response by cancelling its unsubmitted quote", async () => {
  const c = client(quotedPayment);
  mocks.approve.mockRejectedValueOnce(Error("offline"));
  render(<Funding client={c} onFunded={async () => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "Approve and pay this quote" }));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Cancel unpaid quote" }));
  await screen.findByText("Quote expired");
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "New quote" }));
  expect(await screen.findByRole("button", { name: "Get quote" })).toHaveProperty("disabled", false);
  expect(c.actor.cancel_quote).toHaveBeenCalledWith(quotedPayment.request.operation);
  expect(c.actor.pay_purchase).not.toHaveBeenCalled();
  expect(mocks.approve).toHaveBeenCalledTimes(1);
});
it("does not submit a payment after lock while ledger approval is still pending", async () => {
  const quoted = {
      ...payment,
      status: { Quoted: null },
      uncertain: false,
    } as Payment,
    c = client(quoted);
  let generation = 0;
  c.session.capture = () => generation;
  let resolve!: (x: unknown) => void;
  mocks.approve.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  render(<Funding client={c} onFunded={async () => {}} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Approve and pay this quote" }),
  );
  await waitFor(() => expect(mocks.approve).toHaveBeenCalled());
  generation++;
  resolve({ Ok: 8n });
  await new Promise((r) => setTimeout(r, 0));
  expect(c.actor.pay_purchase).not.toHaveBeenCalled();
});

it.each(["Quoted", "Unknown"])(
  "production funding keeps %s history readable without approving or paying",
  async (status) => {
    mocks.mode = "unavailable";
    const c = client({ ...payment, status: { [status]: null } } as Payment);
    render(<Funding client={c} onFunded={async () => {}} />);
    const check = await screen.findByRole("button", {
      name: "Check payment status",
    });
    expect(screen.getByText(/Funding is unavailable/)).toBeTruthy();
    const pay = screen.getByRole("button", {
      name:
        status === "Quoted"
          ? "Approve and pay this quote"
          : "Retry same payment",
    });
    expect((pay as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(pay);
    fireEvent.click(check);
    await waitFor(() => expect(c.actor.payment_status).toHaveBeenCalled());
    expect(mocks.approve).not.toHaveBeenCalled();
    expect(c.actor.pay_purchase).not.toHaveBeenCalled();
    expect(c.actor.quote_purchase).not.toHaveBeenCalled();
  },
);
it("production cannot request new quotes", async () => {
  mocks.mode = "unavailable";
  const c = client();
  vi.mocked(c.actor.list_payments).mockResolvedValue({ Ok: [] });
  render(<Funding client={c} onFunded={async () => {}} />);
  await waitFor(() => expect(c.actor.list_payments).toHaveBeenCalled());
  const quote = screen.getByRole("button", { name: "Get quote" });
  expect((quote as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(quote);
  expect(c.actor.quote_purchase).not.toHaveBeenCalled();
});

it("scans at most ten calls per click and resumes only on another click", async () => {
  const c = client();
  const scan = vi.fn(async () => ({
    payment,
    scanned: 100n,
    next: 1000n,
    end: 3000n,
    can_continue: true,
  }));
  c.reconcilePurchase = scan;
  render(<Funding client={c} onFunded={async () => {}} />);
  const button = await screen.findByRole("button", {
    name: "Scan ledger for this payment",
  });
  expect(scan).not.toHaveBeenCalled();
  fireEvent.click(button);
  await waitFor(() => expect(scan).toHaveBeenCalledTimes(10));
  const resume = await screen.findByRole("button", {
    name: "Resume ledger scan",
  });
  await waitFor(() =>
    expect((resume as HTMLButtonElement).disabled).toBe(false),
  );
  expect(c.actor.pay_purchase).not.toHaveBeenCalled();
  fireEvent.click(resume);
  await waitFor(() => expect(scan).toHaveBeenCalledTimes(20));
});
it("stops a scan on failure without replacing or paying the pending payment", async () => {
  const c = client();
  c.reconcilePurchase = vi.fn().mockRejectedValue(Error("offline"));
  render(<Funding client={c} onFunded={async () => {}} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Scan ledger for this payment" }),
  );
  await screen.findByRole("alert");
  expect(c.reconcilePurchase).toHaveBeenCalledTimes(1);
  expect(c.actor.pay_purchase).not.toHaveBeenCalled();
  expect(c.actor.quote_purchase).not.toHaveBeenCalled();
});
it("accepts certified production capability for quoted payments", async () => {
  mocks.mode = "production";
  const c = client({ ...payment, status: { Quoted: null } });
  render(<Funding client={c} onFunded={async () => {}} />);
  const button = await screen.findByRole("button", {
    name: "Approve and pay this quote",
  });
  await waitFor(() =>
    expect((button as HTMLButtonElement).disabled).toBe(false),
  );
});

it.each(["lock", "switch", "unmount", "stop"])(
  "fences pending ledger replies after %s",
  async (event) => {
    const c = client();
    let generation = 0;
    c.session.capture = () => generation;
    let resolve!: (value: any) => void;
    c.reconcilePurchase = vi.fn(
      () =>
        new Promise<ReconciliationProgress>((r) => {
          resolve = r;
        }),
    );
    const funded = vi.fn(async () => {});
    const view = render(<Funding client={c} onFunded={funded} />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Scan ledger for this payment",
      }),
    );
    await waitFor(() => expect(c.reconcilePurchase).toHaveBeenCalledTimes(1));
    if (event === "lock") generation++;
    if (event === "switch")
      view.rerender(<Funding client={client()} onFunded={funded} />);
    if (event === "unmount") view.unmount();
    if (event === "stop")
      fireEvent.click(screen.getByRole("button", { name: "Stop ledger scan" }));
    resolve({
      payment: { ...payment, status: { Paid: 12n } },
      scanned: 100n,
      next: 100n,
      end: 2000n,
      can_continue: true,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(c.reconcilePurchase).toHaveBeenCalledTimes(1);
    expect(funded).not.toHaveBeenCalled();
    expect(screen.queryByText("Paid")).toBeNull();
  },
);

it("selects a saved pending payment without starting a ledger request", async () => {
  const c = client();
  const second = {
    ...payment,
    request: { ...payment.request, operation: new Uint8Array(16).fill(5) },
    status: { InFlight: null },
  };
  vi.mocked(c.actor.list_payments).mockResolvedValue({ Ok: [payment, second] });
  c.reconcilePurchase = vi.fn(async () => ({
    payment: second,
    scanned: 1n,
    next: 1n,
    end: 1n,
    can_continue: false,
  }));
  render(<Funding client={c} onFunded={async () => {}} />);
  fireEvent.change(
    await screen.findByRole("combobox", { name: "Saved payment" }),
    { target: { value: "1" } },
  );
  expect(c.reconcilePurchase).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "Scan ledger for this payment" }),
  );
  await waitFor(() =>
    expect(c.reconcilePurchase).toHaveBeenCalledWith(second.request.operation),
  );
  await screen.findByText(/No matching payment evidence found yet/);
  expect(c.actor.quote_purchase).not.toHaveBeenCalled();
});

it("shows the persisted ledger cursor after reopening without scanning", async () => {
  const p: Payment = {
    ...payment,
    reconciliation: [
      {
        start: 10n,
        next: 310n,
        end: 1010n,
        spender: payment.wallet,
        lease: 0n,
        lease_until: 0n,
        lease_generation: 0n,
      },
    ],
  };
  const c = client(p);
  c.reconcilePurchase = vi.fn();
  render(<Funding client={c} onFunded={async () => {}} />);
  await screen.findByRole("button", { name: "Resume ledger scan" });
  expect(screen.getByText(/next 310 of 1010/)).toBeTruthy();
  expect(c.reconcilePurchase).not.toHaveBeenCalled();
});


it("displays the exact restored quote amount that approval will spend", async () => {
  const p: Payment = {
    ...payment,
    request: { ...payment.request, amount_e8s: 1_012_345_678n },
    status: { Quoted: null },
    uncertain: false,
  };
  const c = client(p);
  mocks.approve.mockResolvedValue({ Ok: 7n });
  render(<Funding client={c} onFunded={async () => {}} />);
  const button = await screen.findByRole("button", { name: "Approve and pay this quote" });
  expect((screen.getByRole("textbox", { name: "KINIC amount" }) as HTMLInputElement).value).toBe("10.12345678");
  fireEvent.click(button);
  await waitFor(() => expect(mocks.approve).toHaveBeenCalledWith(expect.objectContaining({ amount: 1_012_345_688n })));
});

it("updates the displayed amount when selecting another saved quote", async () => {
  const second: Payment = {
    ...payment,
    request: { ...payment.request, operation: new Uint8Array(16).fill(5), amount_e8s: 1n },
    status: { Quoted: null },
  };
  const c = client();
  vi.mocked(c.actor.list_payments).mockResolvedValue({ Ok: [payment, second] });
  render(<Funding client={c} onFunded={async () => {}} />);
  fireEvent.change(await screen.findByRole("combobox", { name: "Saved payment" }), { target: { value: "1" } });
  expect((screen.getByRole("textbox", { name: "KINIC amount" }) as HTMLInputElement).value).toBe("0.00000001");
});
