// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Ed25519KeyIdentity } from "@icp-sdk/core/identity";
import { VaultClient } from "@kinic/vault-client";
import { VaultRecovery } from "./recovery";
import type { VaultActor } from "@kinic/vault-client/contracts";
afterEach(cleanup);
it("offers three deliberate recovery actions and clears a pending source file selection on lock", async () => {
  const client = new VaultClient({
    actor: {
      restore_admission_status: async () => ({ Ok: [] }),
      incident_context: async () => ({
        Ok: { namespace: new Uint8Array(32), credentials: [] },
      }),
    } as unknown as VaultActor,
    identity: Ed25519KeyIdentity.generate(),
    canister: "aaaaa-aa",
    local: true,
  });
  const run = (f: () => Promise<void>) => {
    void f().catch(() => {});
  };
  function Harness() {
    return (
      <VaultRecovery
        client={client}
        disabled={false}
        enabled={true}
        run={run}
        onChanged={async () => {}}
      />
    );
  }
  render(<Harness />);
  fireEvent.click(
    screen.getByRole("button", { name: "Recover after losing all passkeys" }),
  );
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", {
        name: "Select source backup and recovery kit",
      }),
    );
  });
  expect(screen.getByLabelText("Select source encrypted backup")).toBeTruthy();
  act(() => client.session.lock());
  expect(screen.queryByLabelText("Select source encrypted backup")).toBeNull();
  expect(screen.queryByText("Restore complete")).toBeNull();
});
it("keeps ordinary credential removal distinct from explicit incident revocation", () => {
  const client = new VaultClient({
    actor: {} as VaultActor,
    identity: Ed25519KeyIdentity.generate(),
    canister: "aaaaa-aa",
    local: true,
  });
  render(
    <VaultRecovery
      client={client}
      disabled={false}
      enabled={true}
      run={vi.fn()}
      onChanged={async () => {}}
    />,
  );
  expect(
    screen.getByRole("button", { name: "Respond to a compromised passkey" }),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", {
      name: "Create a new empty Vault with scoped access",
    }),
  ).toBeTruthy();
});
it("uses an obscured legacy source secret and clears its detached input on lock", async () => {
  const client = new VaultClient({
    actor: {
      restore_admission_status: async () => ({ Ok: [] }),
      incident_context: async () => ({ Ok: [] }),
    } as unknown as VaultActor,
    identity: Ed25519KeyIdentity.generate(),
    canister: "aaaaa-aa",
    local: true,
  });
  render(
    <VaultRecovery
      client={client}
      disabled={false}
      enabled={true}
      run={(f) => {
        void f().catch(() => {});
      }}
      onChanged={async () => {}}
    />,
  );
  await act(async () =>
    fireEvent.click(
      screen.getByRole("button", { name: "Recover after losing all passkeys" }),
    ),
  );
  fireEvent.change(screen.getByLabelText("Source recovery format"), {
    target: { value: "legacy" },
  });
  const input = screen.getByLabelText(
    "Original legacy recovery secret",
  ) as HTMLInputElement;
  expect(input.type).toBe("password");
  fireEvent.change(input, { target: { value: "synthetic-private-secret" } });
  act(() => client.session.lock());
  expect(input.value).toBe("");
  expect(screen.queryByDisplayValue("synthetic-private-secret")).toBeNull();
});
