// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { act, render, screen } from "@testing-library/react";
import { createWalletSessionManager } from "../src/wallet-session";
import { WalletSessionProvider, useWalletSession } from "../src/react";

it("keeps the manager and signer across a route remount, and releases the popup on pagehide", async () => {
  const wallet = { accounts: vi.fn(async () => [{ owner: "aaaaa-aa" }]), disconnect: vi.fn(async () => {}),
    permissions: vi.fn(async () => [{ scope: { method: "icrc27_accounts" as const }, state: "granted" as const }]), requestPermissions: vi.fn(), callCanister: vi.fn() };
  const openSigner = vi.fn(async () => wallet);
  const manager = createWalletSessionManager({ origin: "https://app.example", host: "https://icp0.io", signerUrl: "https://wallet.example/sign", transports: { openSigner } });
  function Route() { const { snapshot } = useWalletSession(); return <output>{snapshot.state}</output>; }
  const app = (route: number) => <StrictMode><WalletSessionProvider manager={manager}><Route key={route}/></WalletSessionProvider></StrictMode>;
  const view = render(app(1));
  await act(async () => { await manager.connect("oisy", []); });
  view.rerender(app(2));
  expect(screen.getByText("connected")).toBeDefined();
  expect(openSigner).toHaveBeenCalledTimes(1);
  expect(wallet.disconnect).not.toHaveBeenCalled();
  await act(async () => { window.dispatchEvent(new Event("pagehide")); });
  expect(wallet.disconnect).toHaveBeenCalledTimes(1);
  await act(async () => { window.dispatchEvent(new Event("pageshow")); });
  expect(screen.getByText("remembered")).toBeDefined();
  expect(openSigner).toHaveBeenCalledTimes(1);
  view.unmount();
});
