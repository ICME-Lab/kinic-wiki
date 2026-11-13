// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Ed25519KeyIdentity } from "@icp-sdk/core/identity";
import { VaultClient } from "@kinic/vault-client";
import { importKey } from "@kinic/vault-crypto";
import { fixtureNetwork } from "../../fixtures/network";
vi.mock("../../../packages/vault-crypto/src/context.ts", async (load) => ({
  ...(await load<
    typeof import("../../../packages/vault-crypto/src/context.ts")
  >()),
  verifiedRoot: async () => importKey(new Uint8Array(32).fill(8)),
}));
vi.mock("../config", () => ({
  loadConfig: async () => ({ fundingMode: "disabled" }),
}));
vi.mock("@kinic/ui/editor", () => ({
  MarkdownEditor: ({
    content,
    onChange,
  }: {
    content: string;
    onChange: (v: string) => void;
  }) => (
    <textarea
      aria-label="Private note body"
      value={content}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));
import { VaultWorkspace } from "./workspace";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
async function mounted() {
  const network = fixtureNetwork();
  const client = new VaultClient({
    actor: network.actor,
    identity: Ed25519KeyIdentity.generate(),
    canister: "rrkah-fqaaa-aaaaa-aaaaq-cai",
    local: true,
  });
  const view = render(<VaultWorkspace client={client} />);
  await screen.findByText("Vault 1 · Active");
  const open = async (n = 1) => {
    fireEvent.click(screen.getByText(`Vault ${n} · Active`));
    await screen.findByLabelText("Document title");
    await waitFor(() =>
      expect(
        (screen.getByText("Refresh Vaults") as HTMLButtonElement).disabled,
      ).toBe(false),
    );
  };
  return { ...network, client, view, open };
}
async function save(title = "Secret note", body = "private words") {
  fireEvent.change(screen.getByLabelText("Document title"), {
    target: { value: title },
  });
  fireEvent.change(screen.getByLabelText("Private note body"), {
    target: { value: body },
  });
  fireEvent.click(screen.getByText("Save document"));
  await screen.findByRole("button", { name: title });
}
it("opens with II, saves and reads encrypted notes, searches locally, retains drafts and root through refresh", async () => {
  const x = await mounted();
  await x.open();
  expect(screen.queryByText(/Unlock|passkey/i)).toBeNull();
  await save();
  fireEvent.click(screen.getByRole("button", { name: "Secret note" }));
  await waitFor(() =>
    expect(
      (screen.getByLabelText("Private note body") as HTMLTextAreaElement).value,
    ).toBe("private words"),
  );
  fireEvent.change(screen.getByLabelText("Private note body"), {
    target: { value: "unsaved draft" },
  });
  const root = x.client.session.root;
  x.headers[0].sequence++;
  fireEvent.click(screen.getByText("Refresh Vaults"));
  await waitFor(() =>
    expect(
      (screen.getByText("Refresh Vaults") as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  expect(x.client.session.root).toBe(root);
  expect(
    (screen.getByLabelText("Private note body") as HTMLTextAreaElement).value,
  ).toBe("unsaved draft");
  fireEvent.change(screen.getByLabelText("Search this Vault locally"), {
    target: { value: "private words" },
  });
  expect(screen.getByRole("button", { name: "Secret note" })).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Search this Vault locally"), {
    target: { value: "absent" },
  });
  expect(screen.queryByRole("button", { name: "Secret note" })).toBeNull();
});
it("retries exact create after refresh and key failure without duplicating a Vault", async () => {
  const x = await mounted();
  x.loseCreate();
  fireEvent.click(screen.getByText("Create Vault"));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByText("Refresh Vaults"));
  await waitFor(() =>
    expect(
      (screen.getByText("Retry Vault creation") as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  x.failKey(true);
  fireEvent.click(screen.getByText("Retry Vault creation"));
  await screen.findByText(/key service is unavailable/);
  expect(x.creation).toHaveLength(2);
  expect(x.creation[0]).toEqual(x.creation[1]);
  expect(x.headers).toHaveLength(3);
  x.failKey(false);
  fireEvent.click(screen.getByText("Retry opening Vault"));
  await screen.findByLabelText("Document title");
  expect(x.headers).toHaveLength(3);
});
it.each(["resume", "cancel"])(
  "handles lost save replies with %s",
  async (action) => {
    const x = await mounted();
    await x.open();
    x.lose("PutChunk");
    fireEvent.change(screen.getByLabelText("Document title"), {
      target: { value: "Lost note" },
    });
    fireEvent.change(screen.getByLabelText("Private note body"), {
      target: { value: "lost content" },
    });
    fireEvent.click(screen.getByText("Save document"));
    await screen.findByRole("alert");
    expect(x.client.hasPendingSave).toBe(true);
    fireEvent.click(
      screen.getByText(action === "resume" ? "Resume save" : "Cancel save"),
    );
    await waitFor(() => expect(x.client.hasPendingSave).toBe(false));
    const chunks = x.calls.filter((m) => "PutChunk" in m.action);
    expect(chunks[0]).toEqual(chunks[1]);
    expect(x.uploads.size).toBe(0);
    if (action === "resume")
      await screen.findByRole("button", { name: "Lost note" });
  },
);
it("retains history after ordinary deletion and purges the document and history", async () => {
  const x = await mounted();
  await x.open();
  await save();
  fireEvent.click(screen.getByRole("button", { name: "Secret note" }));
  await screen.findByText("Show version history");
  fireEvent.click(screen.getByText("Show version history"));
  await screen.findByText("Revision 1");
  fireEvent.click(screen.getByText("Delete document"));
  await screen.findByRole("button", { name: "Secret note (deleted)" });
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: "Secret note (deleted)",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Secret note (deleted)" }),
  );
  await waitFor(() =>
    expect(
      (screen.getByText("Show version history") as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByText("Show version history"));
  await screen.findByText("Download revision 1");
  vi.spyOn(window, "confirm").mockReturnValue(true);
  fireEvent.click(screen.getByText("Permanently delete document and history"));
  await waitFor(() => expect(x.revisions).toHaveLength(0));
  await screen.findByText(
    "No documents yet. Create a note, credential or attachment.",
  );
});
it("cleans orphan uploads and purges an entire Vault with zero balance", async () => {
  const x = await mounted();
  await x.open();
  x.uploads.set("orphan", {
    vault: x.headers[0].id,
    object: new Uint8Array(16),
    operation: new Uint8Array(16).fill(9),
    expected_revision: 0n,
    plain_size: 0n,
    manifest: [],
    chunk_hashes: [],
  });
  // Store under the network actor's canonical upload key.
  const request = x.uploads.get("orphan")!;
  x.uploads.delete("orphan");
  x.uploads.set(Array.from(request.operation).join(","), request);
  x.setBalance(0n);
  fireEvent.click(screen.getByText("Refresh balance"));
  await screen.findByText("Prepaid balance: 0 cycles");
  fireEvent.click(screen.getByText("Interrupted uploads"));
  fireEvent.click(screen.getByText("Refresh interrupted uploads"));
  const cancel = await screen.findByText("Cancel interrupted upload 1");
  fireEvent.click(cancel);
  await waitFor(() => expect(x.uploads.size).toBe(0));
  fireEvent.click(screen.getByText("Encrypted storage cleanup"));
  vi.spyOn(window, "confirm").mockReturnValue(true);
  fireEvent.click(screen.getByText("Permanently purge entire Vault"));
  await waitFor(() => expect(x.headers).toHaveLength(1));
  expect(x.client.session.root).toBeUndefined();
  expect(screen.queryByLabelText("Document title")).toBeNull();
});
it.each(["switch", "close", "unmount"])(
  "rejects late private reads on %s and clears private DOM",
  async (action) => {
    const x = await mounted();
    await x.open();
    await save();
    fireEvent.change(screen.getByLabelText("Document title"), {
      target: { value: "private draft" },
    });
    const input = screen.getByLabelText("Document title") as HTMLInputElement;
    const original = x.actor.get_chunk;
    let finish!: () => void;
    vi.spyOn(x.actor, "get_chunk").mockImplementation(
      (...args) =>
        new Promise((resolve) => {
          finish = () => {
            void original(...args).then(resolve);
          };
        }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Secret note" }));
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    if (action === "unmount") x.view.unmount();
    else {
      fireEvent.click(screen.getByText("Close Vault"));
      if (action === "switch") await x.open(2);
    }
    expect(input.value).toBe("");
    await act(async () => finish());
    expect(screen.queryByText("private words")).toBeNull();
    if (action === "switch")
      expect(Array.from(x.client.header!.id)).toEqual(
        Array.from(x.headers[1].id),
      );
  },
);
it.each(["nonce", "public_key", "gone", "deleting"])(
  "closes the private view when refreshed target becomes %s",
  async (change) => {
    const x = await mounted();
    await x.open();
    if (change === "gone") x.headers.shift();
    else if (change === "deleting") x.headers[0].state = { Deleting: null };
    else
      x.headers[0][change as "nonce" | "public_key"] = new Uint8Array(
        change === "nonce" ? 32 : 96,
      ).fill(9);
    fireEvent.click(screen.getByText("Refresh Vaults"));
    await waitFor(() => expect(x.client.session.root).toBeUndefined());
    expect(screen.queryByLabelText("Document title")).toBeNull();
  },
);
it("saves credentials as user content and an attachment without extra authentication", async () => {
  const x = await mounted();
  await x.open();
  fireEvent.change(screen.getByLabelText("Document type"), {
    target: { value: "credential" },
  });
  for (const [label, value] of [
    ["Document title", "Login"],
    ["Username", "alice"],
    ["Password", "secret"],
    ["URL (stored as text)", "https://example.test"],
    ["Credential notes", "memo"],
  ])
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  fireEvent.click(screen.getByText("Save document"));
  await screen.findByRole("button", { name: "Login" });
  fireEvent.click(screen.getByRole("button", { name: "Login" }));
  await waitFor(() =>
    expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe(
      "secret",
    ),
  );
  fireEvent.click(screen.getByText("Show password"));
  expect(screen.getByLabelText("Password").getAttribute("type")).toBe("text");
  fireEvent.click(screen.getByText("New document"));
  fireEvent.change(screen.getByLabelText("Document type"), {
    target: { value: "attachment" },
  });
  fireEvent.change(screen.getByLabelText("Document title"), {
    target: { value: "File" },
  });
  const file = new File(["file bytes"], "note.txt", { type: "text/plain" });
  Object.defineProperty(file, "arrayBuffer", {
    value: async () => new TextEncoder().encode("file bytes").buffer,
  });
  fireEvent.change(screen.getByLabelText("Attachment (10 MiB maximum)"), {
    target: { files: [file] },
  });
  fireEvent.click(screen.getByText("Save document"));
  await screen.findByRole("button", { name: "File" });
  const doc = await x.client.read(x.revisions.at(-1)!);
  expect(doc.metadata.filename).toBe("note.txt");
  expect(new TextDecoder().decode(doc.plaintext)).toBe("file bytes");
  doc.plaintext.fill(0);
});
it("closes on hidden-tab expiry and revokes owned Blob URLs", async () => {
  const x = await mounted();
  await x.open();
  const revoke = vi.fn();
  vi.stubGlobal("URL", Object.assign(URL, { revokeObjectURL: revoke }));
  x.client.session.urls.add("blob:private");
  await act(async () => {
    x.client.session.visible(true);
    x.client.session.expire(Date.now() + 60001);
  });
  expect(revoke).toHaveBeenCalledWith("blob:private");
  expect(screen.queryByLabelText("Document title")).toBeNull();
});
it("keeps production funding disabled", async () => {
  await mounted();
  const account = screen.getByRole("region", { name: "Vault account" });
  expect(
    (within(account).getByText("Get quote") as HTMLButtonElement).disabled,
  ).toBe(true);
});
it.each(["Pending", "Deleting"] as const)(
  "allows cleanup of a %s header after reload without requesting a key",
  async (state) => {
    const x = await mounted();
    x.headers[0].state =
      state === "Pending" ? { Pending: null } : { Deleting: null };
    fireEvent.click(screen.getByText("Refresh Vaults"));
    await screen.findByText(`Vault 1 · ${state}`);
    const derive = vi.spyOn(x.actor, "derive_vault_key");
    fireEvent.click(screen.getByText(`Vault 1 · ${state}`));
    await screen.findByText(
      `This Vault is ${state.toLowerCase()}. Use cleanup to remove its unfinished data.`,
    );
    fireEvent.click(screen.getByText("Encrypted storage cleanup"));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(screen.getByText("Permanently purge entire Vault"));
    await waitFor(() => expect(x.headers).toHaveLength(1));
    expect(derive).not.toHaveBeenCalled();
    expect(x.client.session.root).toBeUndefined();
  },
);
it("retains the draft after optimistic conflict and lets cancellation reopen the current version", async () => {
  const x = await mounted();
  await x.open();
  await save();
  fireEvent.click(screen.getByRole("button", { name: "Secret note" }));
  await waitFor(() =>
    expect(
      (screen.getByLabelText("Private note body") as HTMLTextAreaElement).value,
    ).toBe("private words"),
  );
  const other = new VaultClient({
    actor: x.actor,
    identity: x.client.identity,
    canister: x.client.canister,
    local: true,
  });
  await other.open(x.headers[0]);
  const old = (await other.items())[0];
  await other.save(
    old.metadata,
    new TextEncoder().encode("newer version"),
    old,
  );
  fireEvent.change(screen.getByLabelText("Private note body"), {
    target: { value: "conflicting draft" },
  });
  fireEvent.click(screen.getByText("Save document"));
  await screen.findByText(/Another update changed/);
  expect(
    (screen.getByLabelText("Private note body") as HTMLTextAreaElement).value,
  ).toBe("conflicting draft");
  fireEvent.click(screen.getByText("Cancel save"));
  await waitFor(() => expect(x.client.hasPendingSave).toBe(false));
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "Secret note" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Secret note" }));
  await waitFor(() =>
    expect(
      (screen.getByLabelText("Private note body") as HTMLTextAreaElement).value,
    ).toBe("newer version"),
  );
  other.destroy();
});
it("does not install a late key response after session expiry", async () => {
  const x = await mounted();
  let finish!: () => void;
  vi.spyOn(x.actor, "derive_vault_key").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = () =>
          resolve({ Ok: { input: [], public_key: [], encrypted_key: [] } });
      }),
  );
  fireEvent.click(screen.getByText("Vault 1 · Active"));
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  await act(async () => x.client.session.expire(Date.now() + 300001));
  await act(async () => finish());
  expect(x.client.session.root).toBeUndefined();
  expect(screen.queryByLabelText("Document title")).toBeNull();
});
it("closes a failed key attempt when its header disappears on refresh", async () => {
  const x = await mounted();
  x.failKey(true);
  fireEvent.click(screen.getByText("Vault 1 · Active"));
  await screen.findByRole("alert");
  const ticket = x.client.session.capture();
  x.headers.shift();
  fireEvent.click(screen.getByText("Refresh Vaults"));
  await waitFor(() =>
    expect(x.client.session.capture()).toBeGreaterThan(ticket),
  );
  expect(screen.queryByText("Retry opening Vault")).toBeNull();
});
