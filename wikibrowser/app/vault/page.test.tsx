// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Ed25519KeyIdentity } from "@icp-sdk/core/identity";
import type { Identity } from "@icp-sdk/core/agent";
const state = vi.hoisted(() => ({
  session: {} as Record<string, unknown>,
  destroy: vi.fn(),
  create: vi.fn(),
}));
vi.mock("@/app/app-session-provider", () => ({
  useAppSession: () => state.session,
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
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
function signedIn(identity: Identity = Ed25519KeyIdentity.generate()) {
  state.session = {
    authReady: true,
    authLoading: false,
    principal: identity.getPrincipal().toText(),
    authClient: { getIdentity: () => identity },
  };
  state.create.mockResolvedValue({ destroy: state.destroy });
  return identity;
}
it("mounts private UI only in an authenticated browser and destroys it before unresolved logout finishes", async () => {
  signedIn();
  const view = render(<VaultPage />);
  await screen.findByLabelText("Private editor");
  state.session = { ...state.session, authLoading: true }; // logout has not resolved; principal is still present
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
