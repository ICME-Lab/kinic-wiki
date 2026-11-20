// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Ed25519KeyIdentity } from "@icp-sdk/core/identity";
import type { Identity } from "@icp-sdk/core/agent";
const state = vi.hoisted(() => ({
  session: {} as Record<string, unknown>,
  destroy: vi.fn(),
  create: vi.fn(),
}));
vi.mock("../auth", () => ({
  useVaultAuth: () => state.session,
}));
vi.mock("./actor", () => ({
  createPrivateVaultClient: (...args: unknown[]) => state.create(...args),
}));
vi.mock("./workspace", () => ({
  VaultWorkspace: () => (
    <textarea aria-label="Private editor" defaultValue="synthetic secret" />
  ),
}));
import VaultPage from "./page";
import { VaultChrome } from "../chrome";
import { VaultNavigationScope } from "../navigation";
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
function signedIn(identity: Identity = Ed25519KeyIdentity.generate()) {
  state.session = {
    identity, loading: false,
  };
  state.create.mockResolvedValue({ destroy: state.destroy });
  return identity;
}
it("moves skip-link focus to the welcome heading when signed out", () => {
  state.session = { loading: false, ready: true };
  render(
    <VaultNavigationScope>
      <VaultChrome />
      <VaultPage />
    </VaultNavigationScope>,
  );
  const skip = screen.getByRole("link", { name: "Skip to content" });
  skip.focus();
  fireEvent.click(skip);
  expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Private Vault" }));
});

it("mounts private UI only in an authenticated browser and destroys it before unresolved logout finishes", async () => {
  signedIn();
  const view = render(<VaultPage />);
  await screen.findByLabelText("Private editor");
  state.session = { ...state.session, loading: true }; // logout has not resolved; principal is still present
  view.rerender(<VaultPage />);
  expect(screen.queryByLabelText("Private editor")).toBeNull();
  expect(state.destroy).toHaveBeenCalledTimes(1);
});
it("destroys and replaces a session when the same principal receives a new identity object", async () => {
  const identity = signedIn();
  const view = render(<VaultPage />);
  await screen.findByLabelText("Private editor");
  signedIn({
    ...identity,
    getPrincipal: () => identity.getPrincipal(),
  } as Identity);
  view.rerender(<VaultPage />);
  await waitFor(() => expect(state.create).toHaveBeenCalledTimes(2));
  expect(state.destroy).toHaveBeenCalledTimes(1);
});
it("destroys a late client initialization after route exit", async () => {
  signedIn();
  let resolve!: (client: unknown) => void;
  state.create.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const view = render(<VaultPage />);
  view.unmount();
  resolve({ destroy: state.destroy });
  await waitFor(() => expect(state.destroy).toHaveBeenCalledTimes(1));
});
it("retries a failed initial connection without replacing the authenticated identity", async()=>{
 signedIn(); state.create.mockRejectedValueOnce(Error("offline"));
 render(<VaultPage/>);
 fireEvent.click(await screen.findByRole("button",{name:"Retry connection"}));
 await screen.findByLabelText("Private editor");
 expect(state.create).toHaveBeenCalledTimes(2);
});
