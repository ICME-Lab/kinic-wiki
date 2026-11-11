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
vi.mock("@kinic/vault-ui/editor", () => ({
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
  published_slot: [],
  generation: [],
  recovery_verifier: [],
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
    global_capacity: vi.fn(async () => ({
      Ok: {
        used: 16777216n,
        limit: 209715200n,
        accounting_reserved: 16777216n,
        overcommitted: false,
        overage: 0n,
        legacy_excess: 0n,
      },
    })),
    list_credentials: vi.fn(async () => ({ Ok: [] })),
    cleanup_status: vi.fn(async () => ({ Ok: [] })),
    list_payments: vi.fn(async () => ({ Ok: [] })),
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
    account_balance: vi.fn(async () => ({ Ok: 1_000_000_000n })),
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
  expect(
    (
      screen.getByRole("button", {
        name: "Unlock with passkey",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
  await act(async () => {
    resolve([]);
    await Promise.resolve();
  });
  expect(screen.queryByLabelText("Private note body")).toBeNull();
});
it("clears recovery secret setup on every lock and excludes legacy restore controls", async () => {
  const { client } = await mounted();
  vi.spyOn(client, "createKit").mockImplementation(async () => {
    client.session.lock();
    return {
      vault: new Uint8Array(16),
      attempt: new Uint8Array(16),
      normal: {
        version: 1,
        nonce: new Uint8Array(12),
        ciphertext: new Uint8Array(48),
      },
      recovery: {
        version: 1,
        nonce: new Uint8Array(12),
        ciphertext: new Uint8Array(48),
      },
      secret: "synthetic-kit-secret",
      recoveryVerifier: new Uint8Array(32),
      generation: client.session.capture(),
    };
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Create Vault" }));
  });
  expect(screen.getByLabelText("New recovery secret").textContent).toBe(
    "synthetic-kit-secret",
  );
  fireEvent.change(screen.getByLabelText("Re-enter saved recovery secret"), {
    target: { value: "synthetic-kit-confirmation" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Lock Vault" }));
  expect(screen.queryByLabelText("New recovery secret")).toBeNull();
  expect(screen.queryByDisplayValue("synthetic-kit-confirmation")).toBeNull();
  expect(screen.queryByLabelText("Restore recovery secret")).toBeNull();
  expect(screen.queryByLabelText("Backup file")).toBeNull();
});
it("shows a sanitized unlock failure without restoring keys or private content", async () => {
  const { client } = await mounted();
  vi.mocked(client.unlock).mockRestore();
  header.generation = [{} as never];
  vi.spyOn(client, "authorize").mockRejectedValue(Error("InvalidProof"));
  fireEvent.click(screen.getByRole("button", { name: "Lock Vault" }));
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", { name: "Unlock with passkey" }),
    );
  });
  header.generation = [];
  expect(screen.getByRole("alert").textContent).toContain(
    "Passkey verification failed",
  );
  expect(screen.queryByLabelText("Private note body")).toBeNull();
  expect(client.session.raw).toBeUndefined();
});
it.each(["InvalidProof", "Busy", "Unauthorized"])(
  "retains the active editor draft after %s so a fresh explicit save can succeed",
  async (error) => {
    const { client } = await mounted();
    fireEvent.change(screen.getByLabelText("Document title"), { target: { value: "unsaved title" } });
    let savedBody = "";
    const save = vi.spyOn(client, "save").mockRejectedValueOnce(Error(error)).mockImplementation(async (_metadata, plain) => {
      savedBody = new TextDecoder().decode(plain);
      return {
        revision: 1n, deleted: false, object: new Uint8Array(16), vault: header.id,
        chunk_hashes: [], sequence: 1n, manifest: new Uint8Array(), plain_size: 1n,
      };
    });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save document" })); });
    expect((screen.getByLabelText("Private note body") as HTMLTextAreaElement).value).toBe("synthetic secret draft");
    expect((screen.getByLabelText("Document title") as HTMLInputElement).value).toBe("unsaved title");
    expect(client.session.root).toBeDefined();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save document" })); });
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1][0].title).toBe("unsaved title");
    expect(savedBody).toBe("synthetic secret draft");
  },
);
