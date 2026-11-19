// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PaymentForm, type PaymentFormProps } from "@kinic/ui/payment-form";

afterEach(cleanup);
const summary = {
  amount: "1", transferFee: "0.0000001", approvalFee: "0.0000001", total: "1.0000002",
  credit: "1.00B cycles", details: [{ label: "Raw cycles", value: "1000000000" }],
};
function props(): PaymentFormProps {
  return {
    sources: [{ id: "oisy", label: "OISY", account: "aaaaa-aa", balanceLabel: null,
      connectionState: "remembered", onConnect: vi.fn() }],
    selectedSource: "oisy", targetLabel: "Vault prepaid account", amount: "1",
    summary, status: { phase: "ready" },
    actions: { onSource: vi.fn(), onAmount: vi.fn(), onReview: vi.fn(), onPay: vi.fn(), canReview: false, canPay: false }
  };
}
it("remembered_wallet_requires_reconnect", () => {
  const p = props();
  render(<PaymentForm {...p} />);
  fireEvent.click(screen.getByRole("button", {name: "Reconnect OISY"}));
  expect(p.sources[0].onConnect).toHaveBeenCalledOnce();
  expect((screen.getByRole("button", {name: "Pay 1 KINIC"}) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText("1.0000002 KINIC")).toBeTruthy();
  expect(screen.getAllByText("0.0000001 KINIC")).toHaveLength(2);
});
it.each([["preparing","Preparing payment"],["approving","Approving"],["paying","Paying"],
  ["checking","Checking payment"],["refreshing","Updating balance"]] as const)("announces %s", (phase, text) => {
  const p = props();
  render(<PaymentForm {...p} status={{phase}} />);
  expect(screen.getByRole("status").textContent).toContain(text);
  expect((screen.getByRole("radio") as HTMLInputElement).disabled).toBe(true);
});
it("preserves the receipt and reports stale balance", () => {
  render(<PaymentForm {...props()} status={{phase:"complete",message:"Credited 1.00B cycles.",balanceUnavailable:true}} />);
  expect(screen.getByRole("status").textContent).toContain("Payment complete");
  expect(screen.getByRole("status").textContent).toContain("Balance unavailable");
});

it("hydrates the server payment source before restoring the browser preference", async () => {
  const { renderToString } = await import("react-dom/server");
  const { act } = await import("@testing-library/react");
  const { hydrateRoot } = await import("react-dom/client");
  const { useFundingProvider } = await import("@kinic/payments/use-payment-flow");
  function Source() {
    const {source} = useFundingProvider("payments.hydration-source");
    return <span>{source}</span>;
  }
  const host = document.createElement("div");
  localStorage.removeItem("payments.hydration-source");
  host.innerHTML = renderToString(<Source/>);
  expect(host.textContent).toBe("ii");
  localStorage.setItem("payments.hydration-source","oisy");
  const errors: unknown[] = [];
  let root!: ReturnType<typeof hydrateRoot>;
  try {
    await act(async()=>{root=hydrateRoot(host,<Source/>,{onRecoverableError:err=>errors.push(err)});});
    expect(host.textContent).toBe("oisy");
    expect(errors).toEqual([]);
  } finally {
    act(()=>root?.unmount());
    localStorage.removeItem("payments.hydration-source");
  }
});
