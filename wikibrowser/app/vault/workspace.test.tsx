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
import { VaultWorkspace } from "./workspace";
vi.mock("@/components/markdown-editor", () => ({
  MarkdownEditor: ({
    content,
    onChange,
  }: {
    content: string;
    onChange: (value: string) => void;
  }) => (
    <textarea
      aria-label="Private note body"
      value={content}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const header: Header = {
  id: new Uint8Array(16),
  epoch: 0n,
  sequence: 1n,
  key_name: "test_key_1",
  state: { Active: null },
  normal: [],
  recovery: [],
  backup_sequence: [],
  backup_at: [],
};
async function mounted() {
  const actor = {
    get_config: vi.fn(async () => ({
      Ok: [
        {
          origin: location.origin,
          rp_id: "localhost",
          key_name: "test_key_1",
          minimum_cycles: 0n,
        },
      ],
    })),
    get_payer: vi.fn(async () => ({ Ok: ["owned"] })),
    list_vaults: vi.fn(async () => ({ Ok: [header] })),
    list_unfinished_vaults: vi.fn(async () => ({ Ok: [] })),
    get_quota: vi.fn(async () => ({
      Ok: { current: 0n, charged: 0n, reserved: 0n, limit: 100n },
    })),
    get_vault_header: vi.fn(async () => ({ Ok: header })),
  } as unknown as VaultActor;
  const client = new VaultClient({
    actor,
    identity: Ed25519KeyIdentity.generate(),
    canister: "aaaaa-aa",
    local: true,
  });
  client.payerDatabases = async () => [{ id: "owned", name: "Owned database" }];
  vi.spyOn(client, "unlock").mockImplementation(async (h) => {
    client.session.lock();
    client.header = h;
    client.session.raw = new Uint8Array(32).fill(7);
    client.session.root = {} as CryptoKey;
  });
  vi.spyOn(client, "items").mockResolvedValue([]);
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<VaultWorkspace client={client} />);
  });
  screen.getByRole("button", { name: "Vault 1" });
  fireEvent.click(screen.getByRole("button", { name: "Vault 1" }));
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", { name: "Unlock with passkey" }),
    );
  });
  screen.getByLabelText("Private note body");
  fireEvent.change(screen.getByLabelText("Private note body"), {
    target: { value: "synthetic secret draft" },
  });
  fireEvent.change(screen.getByLabelText("Search this Vault locally"), {
    target: { value: "synthetic search" },
  });
  return { ...view, client };
}
it.each(["idle", "hidden", "pagehide", "manual"] as const)(
  "destroys private editor, search, key and Blob state on %s lock",
  async (reason) => {
    vi.useFakeTimers();
    const { client } = await mounted();
    const raw = client.session.raw!;
    const revoke = vi.fn();
    Object.defineProperty(URL, "revokeObjectURL", {
      value: revoke,
      configurable: true,
    });
    client.session.urls.add("blob:synthetic");
    act(() => {
      if (reason === "idle") vi.advanceTimersByTime(300000);
      if (reason === "hidden") {
        client.session.visible(true);
        vi.advanceTimersByTime(60000);
      }
      if (reason === "pagehide") window.dispatchEvent(new Event("pagehide"));
      if (reason === "manual")
        fireEvent.click(screen.getByRole("button", { name: "Lock Vault" }));
    });
    expect(screen.queryByLabelText("Private note body")).toBeNull();
    expect(screen.queryByDisplayValue("synthetic search")).toBeNull();
    expect(document.body.textContent).not.toContain("synthetic secret draft");
    expect(client.session.root).toBeUndefined();
    expect(raw.every((x) => x === 0)).toBe(true);
    expect(revoke).toHaveBeenCalledWith("blob:synthetic");
  },
);
it("rejects late local search results after a lock", async () => {
  const { client } = await mounted();
  let resolve!: (items: never[]) => void;
  vi.mocked(client.items).mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  // Start unlocking a fresh generation, then lock while the metadata/index fetch is pending.
  fireEvent.click(screen.getByRole("button", { name: "Lock Vault" }));
  fireEvent.click(screen.getByRole("button", { name: "Unlock with passkey" }));
  await act(async () => {
    await Promise.resolve();
  });
  fireEvent.click(screen.getByRole("button", { name: "Lock Vault" }));
  await act(async () => {
    resolve([]);
    await Promise.resolve();
  });
  expect(screen.queryByLabelText("Private note body")).toBeNull();
});
it('clears recovery secrets, create kit and restore file input on every lock', async () => {
  const { client } = await mounted();
  vi.spyOn(client, 'createKit').mockImplementation(async () => {
    client.session.lock();
    return { vault: new Uint8Array(16), attempt: new Uint8Array(16), normal: { version: 1, nonce: new Uint8Array(12), ciphertext: new Uint8Array(48) }, recovery: { version: 1, nonce: new Uint8Array(12), ciphertext: new Uint8Array(48) }, secret: 'synthetic-kit-secret', generation: client.session.capture() };
  });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create Vault' })); });
  expect(screen.getByLabelText('New recovery secret').textContent).toBe('synthetic-kit-secret');
  fireEvent.change(screen.getByLabelText('Re-enter saved recovery secret'), { target: { value: 'synthetic-kit-confirmation' } });
  fireEvent.change(screen.getByLabelText('Restore recovery secret'), { target: { value: 'synthetic-restore-secret' } });
  fireEvent.change(screen.getByLabelText('Backup file'), { target: { files: [new File(['synthetic'], 'synthetic.kvault')] } });
  fireEvent.click(screen.getByRole('button', { name: 'Lock Vault' }));
  expect(screen.queryByLabelText('New recovery secret')).toBeNull();
  expect(screen.queryByDisplayValue('synthetic-kit-confirmation')).toBeNull();
  expect(screen.getByLabelText('Restore recovery secret')).toHaveProperty('value', '');
  expect((screen.getByLabelText('Backup file') as HTMLInputElement).files?.length).toBe(0);
});
