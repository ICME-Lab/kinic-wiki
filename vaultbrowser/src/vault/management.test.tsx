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
import type { Header, VaultActor } from "@kinic/vault-client/contracts";
import { VaultBackups, VaultEncryptedCleanup } from "./management";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const header: Header = {
  published_slot: [],
  generation: [],
  recovery_verifier: [],
  id: new Uint8Array(16),
  epoch: 0n,
  sequence: 0n,
  state: { Active: null },
  key_name: "test_key_1",
  normal: [],
  recovery: [],
  backup_sequence: [],
  backup_at: [],
};
const run = (f: () => Promise<void>) => {
  void f();
};
it("requires authenticated full-Vault cleanup while locked and never calls legacy object purge", async () => {
  const purge_object = vi.fn(),
    client = new VaultClient({
      actor: {
        purge_object,
        cleanup_status: async () => ({ Ok: [] }),
      } as unknown as VaultActor,
      identity: Ed25519KeyIdentity.generate(),
      canister: "aaaaa-aa",
      local: true,
    });
  const cleanup = vi
    .spyOn(client, "cleanup")
    .mockResolvedValue({ job: new Uint8Array(16), cursor: 1n, complete: true });
  vi.spyOn(window, "confirm").mockReturnValue(true);
  const onChanged = vi.fn(async () => {});
  render(
    <VaultEncryptedCleanup
      client={client}
      selected={header}
      disabled={false}
      run={run}
      onChanged={onChanged}
    />,
  );
  fireEvent.click(
    screen.getByText("Encrypted storage cleanup", { selector: "summary" }),
  );
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", { name: "Permanently purge entire Vault" }),
    );
  });
  expect(cleanup).toHaveBeenCalledWith(header, true, expect.any(Function));
  expect(purge_object).not.toHaveBeenCalled();
  expect(client.session.root).toBeUndefined();
  expect(onChanged).toHaveBeenCalled();
});
it("clears locked recovery input immediately and exports through the recovery path only", async () => {
  const client = new VaultClient();
  const backup = vi
    .spyOn(client, "backup")
    .mockRejectedValue(Error("Unexpected"));
  const recovery = vi.spyOn(client, "backupWithRecovery").mockResolvedValue({
    exportId: new Uint8Array(16),
    data: new Uint8Array([1]),
  });
  vi.spyOn(client.session, "download").mockImplementation(() => {});
  render(
    <VaultBackups
      client={client}
      selected={header}
      unlocked={false}
      disabled={false}
      run={run}
      onChanged={async () => {}}
    />,
  );
  fireEvent.change(screen.getByLabelText("Export recovery secret"), {
    target: { value: "synthetic-recovery-secret" },
  });
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", { name: "Download encrypted backup" }),
    );
  });
  expect(screen.getByLabelText("Export recovery secret")).toHaveProperty(
    "value",
    "",
  );
  expect(recovery).toHaveBeenCalledWith(header, "synthetic-recovery-secret");
  expect(backup).not.toHaveBeenCalled();
});
it("shows persisted incomplete cleanup progress after remount without claiming completion", async () => {
  const client = new VaultClient({
    actor: {
      cleanup_status: async () => ({
        Ok: [{ job: new Uint8Array(16), cursor: 7n, complete: false }],
      }),
    } as unknown as VaultActor,
    identity: Ed25519KeyIdentity.generate(),
    canister: "aaaaa-aa",
    local: true,
  });
  render(
    <VaultEncryptedCleanup
      client={client}
      selected={header}
      disabled={false}
      run={run}
      onChanged={async () => {}}
    />,
  );
  fireEvent.click(
    screen.getByText("Encrypted storage cleanup", { selector: "summary" }),
  );
  expect(
    (
      await screen.findByText(
        "Pending cleanup batch 7 — resume the original Vault and action",
      )
    ).textContent,
  ).not.toContain("complete");
});
