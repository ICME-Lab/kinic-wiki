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
const credit = vi.hoisted(() => ({ prepare: vi.fn() }));
vi.mock("../wiki-credit-actor", () => ({
  creditOrigins: () => ({
    wiki: "https://wiki.kinic.xyz",
    vault: "https://vault.kinic.xyz",
  }),
  vaultCreditActor: async (client: VaultClient) => ({
    wiki_link_status: async () => ({
      Ok: [
        {
          wiki_owner: client.identity.getPrincipal(),
          vault_owner: client.identity.getPrincipal(),
          generation: 1n,
          active: true,
        },
      ],
    }),
    prepare_wiki_credit: credit.prepare,
  }),
}));
import { VaultWorkspace } from "./workspace";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
async function mounted() {
  const identity = Ed25519KeyIdentity.generate();
  const network = fixtureNetwork(identity.getPrincipal());
  const client = new VaultClient({
    actor: network.actor,
    identity,
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
  await waitFor(() =>
    expect(
      (screen.getByText("Refresh balance") as HTMLButtonElement).disabled,
    ).toBe(false),
  );
}
function largeAttachment(title: string) {
  fireEvent.change(screen.getByLabelText("Document type"), {
    target: { value: "attachment" },
  });
  fireEvent.change(screen.getByLabelText("Document title"), {
    target: { value: title },
  });
  const bytes = new Uint8Array(262145).fill(7);
  const file = new File([bytes], "large.bin", {
    type: "application/octet-stream",
  });
  Object.defineProperty(file, "arrayBuffer", {
    value: async () => bytes.buffer.slice(0),
  });
  fireEvent.change(screen.getByLabelText("Attachment (10 MiB maximum)"), {
    target: { files: [file] },
  });
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
  expect(screen.queryByRole("button", { name: "Secret note" })).toBeNull();
  fireEvent.click(screen.getByText("Search note bodies"));
  await screen.findByText("Note body search complete.");
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
  await x.open(2);
  expect(screen.getByText("Retry Vault creation")).toBeTruthy();
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
it.each([
  ["resume", "SaveInline"],
  ["cancel", "SaveInline"],
  ["resume", "BeginRevision"],
  ["resume", "PutChunk"],
  ["resume", "CommitRevision"],
  ["cancel", "BeginRevision"],
  ["cancel", "PutChunk"],
  ["cancel", "CommitRevision"],
])("handles %s after a lost %s reply", async (action, phase) => {
  const x = await mounted();
  await x.open();
  x.lose(phase);
  if (phase === "SaveInline") {
    fireEvent.change(screen.getByLabelText("Document title"), {
      target: { value: "Lost attachment" },
    });
    fireEvent.change(screen.getByLabelText("Private note body"), {
      target: { value: "inline body" },
    });
  } else largeAttachment("Lost attachment");
  fireEvent.click(screen.getByText("Save document"));
  await screen.findByRole("alert");
  expect(x.client.hasPendingSave).toBe(true);
  fireEvent.click(
    screen.getByText(action === "resume" ? "Resume save" : "Cancel save"),
  );
  await waitFor(() => expect(x.client.hasPendingSave).toBe(false));
  const retries = x.calls.filter((m) => phase in m.action);
  expect(retries).toHaveLength(
    phase === "SaveInline" && action === "cancel" ? 1 : 2,
  );
  if (retries.length === 2) expect(retries[0]).toEqual(retries[1]);
  expect(x.uploads.size).toBe(0);
  if (action === "resume")
    await screen.findByRole("button", { name: "Lost attachment" });
});
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
  fireEvent.click(
    screen.getByText("Account & storage", { selector: "summary" }),
  );
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
it("retains the draft after definitive optimistic conflict and permits reopening the current version", async () => {
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
  expect(x.client.hasPendingSave).toBe(false);
  fireEvent.click(screen.getByText("Refresh documents"));
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

it("keeps the open draft and root when account and upload disclosures are toggled", async () => {
  const x = await mounted();
  await x.open();
  fireEvent.change(screen.getByLabelText("Private note body"), {
    target: { value: "unsaved private draft" },
  });
  const root = x.client.session.root;
  const ticket = x.client.session.capture();
  for (const name of ["Account & storage", "Interrupted uploads"]) {
    const summary = screen.getByText(name, { selector: "summary" });
    fireEvent.click(summary);
    expect(summary.closest("details")?.open).toBe(true);
    expect(x.client.session.root).toBe(root);
    expect(x.client.session.capture()).toBe(ticket);
    expect(screen.getByDisplayValue("unsaved private draft")).toBeTruthy();
  }
  fireEvent.click(screen.getByRole("button", { name: "Close Vault" }));
  expect(x.client.session.root).toBeUndefined();
  expect(screen.queryByDisplayValue("unsaved private draft")).toBeNull();
});
it("toggles navigation without disturbing drafts and returns focus before switching Vaults", async () => {
  const x = await mounted();
  await x.open();
  fireEvent.change(screen.getByLabelText("Document title"), {
    target: { value: "private draft" },
  });
  const root = x.client.session.root;
  const toggle = screen.getByRole("button", {
    name: "Toggle Vault navigation",
  });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(x.client.session.root).toBe(root);
  expect(screen.getByDisplayValue("private draft")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Vault 2 · Active" }));
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(toggle);
  expect(screen.queryByDisplayValue("private draft")).toBeNull();
  await waitFor(() =>
    expect(Array.from(x.client.header?.id ?? [])).toEqual(
      Array.from(x.headers[1].id),
    ),
  );
  await screen.findByLabelText("Document title");
});
it("keeps the loss disclosure before create and outside collapsed navigation", async () => {
  await mounted();
  const disclosure = screen.getByText(
    /This release has no backup or independent recovery/,
  );
  const create = screen.getByRole("button", { name: "Create Vault" });
  expect(create.getAttribute("aria-describedby")).toBe(disclosure.id);
  expect(disclosure.closest("#vault-navigation")).toBeNull();
  expect(
    disclosure.compareDocumentPosition(create) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});

it("allows owner credit below the valid canister reserve and reports server denial", async () => {
  const x = await mounted();
  expect((screen.getByText("Create Vault") as HTMLButtonElement).disabled).toBe(
    false,
  );
  await x.open();
  await save("First", "first body");
  x.lose("SaveInline");
  fireEvent.change(screen.getByLabelText("Private note body"), {
    target: { value: "retry body" },
  });
  fireEvent.click(screen.getByText("Save document"));
  await screen.findByRole("alert");
  expect((screen.getByText("Resume save") as HTMLButtonElement).disabled).toBe(
    false,
  );
  fireEvent.click(screen.getByText("Resume save"));
  await waitFor(() => expect(x.client.hasPendingSave).toBe(false));
  await waitFor(() =>
    expect(
      (screen.getByText("Refresh balance") as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  x.setBalance(1n);
  fireEvent.click(screen.getByText("Refresh balance"));
  await screen.findByText("Prepaid balance: 1 cycles");
  // A nonzero balance is advisory: the server owns fee/execution admission.
  vi.spyOn(x.actor, "create_vault").mockResolvedValue({
    Err: { QuotaExceeded: null },
  });
  fireEvent.click(screen.getByText("Create Vault"));
  await screen.findByRole("alert");
  expect(x.actor.create_vault).toHaveBeenCalledOnce();
  await waitFor(() =>
    expect(
      (screen.getByText("Refresh balance") as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  x.setBalance(0n);
  fireEvent.click(screen.getByText("Refresh balance"));
  await screen.findByText("Prepaid balance: 0 cycles");
  expect(
    (screen.getByText("Retry Vault creation") as HTMLButtonElement).disabled,
  ).toBe(true);
});
it("purges a selected document and its history at zero credit while retaining another", async () => {
  const x = await mounted();
  await x.open();
  await save("Keep", "retained body");
  fireEvent.click(screen.getByText("New document"));
  await save("Remove", "old body");
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  await waitFor(() =>
    expect(
      (screen.getByLabelText("Private note body") as HTMLTextAreaElement).value,
    ).toBe("old body"),
  );
  await save("Remove", "new body");
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  await screen.findByText("Show version history");
  x.setBalance(0n);
  fireEvent.click(screen.getByText("Refresh balance"));
  await screen.findByText("Prepaid balance: 0 cycles");
  expect(
    (screen.getByText("Delete document") as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(
    (screen.getByText("Save document") as HTMLButtonElement).disabled,
  ).toBe(true);
  vi.spyOn(window, "confirm").mockReturnValue(true);
  fireEvent.click(screen.getByText("Permanently delete document and history"));
  await waitFor(() => expect(x.revisions).toHaveLength(1));
  expect(screen.getByRole("button", { name: "Keep" })).toBeTruthy();
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull(),
  );
});
it.each(["Pending", "Deleting", "failed-open"])(
  "retries lost Collect from a closed %s Vault at zero credit",
  async (state) => {
    const x = await mounted();
    if (state === "failed-open") x.failKey(true);
    else
      x.headers[0].state =
        state === "Pending" ? { Pending: null } : { Deleting: null };
    x.setBalance(0n);
    fireEvent.click(screen.getByText("Refresh balance"));
    await screen.findByText("Prepaid balance: 0 cycles");
    fireEvent.click(screen.getByText("Refresh Vaults"));
    await waitFor(() =>
      expect(
        (screen.getByText("Refresh Vaults") as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(
      screen.getByText(
        `Vault 1 · ${state === "failed-open" ? "Active" : state}`,
      ),
    );
    await screen.findByText("Encrypted storage cleanup");
    await waitFor(() =>
      expect(
        (screen.getByText("Collect expired data") as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    x.lose("Collect");
    fireEvent.click(screen.getByText("Encrypted storage cleanup"));
    fireEvent.click(screen.getByText("Collect expired data"));
    await waitFor(() => expect(x.calls).toHaveLength(1));
    await waitFor(() =>
      expect(
        (screen.getByText("Collect expired data") as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByText("Collect expired data"));
    await screen.findByText("Cleanup complete");
    expect(x.calls[0]).toEqual(x.calls[1]);
    expect(x.client.session.root).toBeUndefined();
    await waitFor(() =>
      expect(
        (screen.getByText("Collect expired data") as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByText("Collect expired data"));
    await waitFor(() => expect(x.calls).toHaveLength(3));
    expect(x.calls[2].operation).not.toEqual(x.calls[0].operation);
  },
);

it("reconciles a lost cancellation reply while retaining the pending save", async () => {
  const x = await mounted();
  await x.open();
  x.lose("PutChunk");
  largeAttachment("Cancelled attachment");
  fireEvent.click(screen.getByText("Save document"));
  await screen.findByRole("alert");
  x.lose("CancelUpload");
  fireEvent.click(screen.getByText("Cancel save"));
  await waitFor(() =>
    expect(x.calls.filter((m) => "CancelUpload" in m.action)).toHaveLength(1),
  );
  await waitFor(() =>
    expect(
      (screen.getByText("Cancel save") as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  expect(x.client.hasPendingSave).toBe(true);
  fireEvent.click(screen.getByText("Cancel save"));
  await waitFor(() => expect(x.client.hasPendingSave).toBe(false));
  const calls = x.calls.filter((m) => "CancelUpload" in m.action);
  expect(calls).toHaveLength(2);
  expect(calls[0]).toEqual(calls[1]);
  expect(x.uploads.size).toBe(0);
  expect(x.revisions).toHaveLength(0);
});

it("keeps newer opening work busy when an old opening finishes after close", async () => {
  const x = await mounted();
  type KeyReply = Awaited<ReturnType<typeof x.actor.derive_vault_key>>;
  let finishOld!: (reply: KeyReply) => void;
  let finishNew!: (reply: KeyReply) => void;
  vi.spyOn(x.actor, "derive_vault_key")
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishNew = resolve;
        }),
    );
  fireEvent.click(screen.getByText("Vault 1 · Active"));
  await waitFor(() => expect(finishOld).toBeTypeOf("function"));
  fireEvent.click(screen.getByText("Close Vault"));
  fireEvent.click(screen.getByText("Vault 2 · Active"));
  await waitFor(() => expect(finishNew).toBeTypeOf("function"));
  const reply = { Ok: { input: [], public_key: [], encrypted_key: [] } };
  await act(async () => finishOld(reply));
  expect(screen.getByText("Processing Vault operation…")).toBeTruthy();
  expect(
    (screen.getByText("Refresh Vaults") as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByLabelText("Document title")).toBeNull();
  await act(async () => finishNew(reply));
  await screen.findByLabelText("Document title");
  await waitFor(() =>
    expect(screen.queryByText("Processing Vault operation…")).toBeNull(),
  );
  expect(Array.from(x.client.header?.id ?? [])).toEqual(
    Array.from(x.headers[1].id),
  );
});

it("lists titles without body reads and searches note bodies only on explicit request", async () => {
  const x = await mounted();
  await x.open();
  await save();
  const reads = vi.spyOn(x.actor, "get_chunk");
  fireEvent.click(screen.getByText("Refresh documents"));
  await waitFor(() =>
    expect(
      (screen.getByText("Refresh documents") as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  expect(reads).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Search this Vault locally"), {
    target: { value: "private words" },
  });
  expect(screen.queryByRole("button", { name: "Secret note" })).toBeNull();
  expect(reads).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Search note bodies"));
  await screen.findByText("Note body search complete.");
  expect(screen.getByRole("button", { name: "Secret note" })).toBeTruthy();
  expect(reads).toHaveBeenCalledOnce();
});
it.each(["stop", "query", "close", "unmount"])(
  "fences late body search after %s without locking other actions",
  async (mode) => {
    const x = await mounted();
    await x.open();
    await save();
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
    fireEvent.change(screen.getByLabelText("Search this Vault locally"), {
      target: { value: "private words" },
    });
    fireEvent.click(screen.getByText("Search note bodies"));
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    expect(screen.getByText("Searching note bodies: 0 / 1")).toBeTruthy();
    expect(
      (screen.getByText("New document") as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(
      (screen.getByText("Refresh balance") as HTMLButtonElement).disabled,
    ).toBe(false);
    if (mode === "stop") fireEvent.click(screen.getByText("Stop search"));
    else if (mode === "query")
      fireEvent.change(screen.getByLabelText("Search this Vault locally"), {
        target: { value: "absent" },
      });
    else if (mode === "close") fireEvent.click(screen.getByText("Close Vault"));
    else x.view.unmount();
    await act(async () => {
      finish();
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(screen.queryByText("Note body search complete.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Secret note" })).toBeNull();
    if (mode === "close") {
      await x.open();
      expect(
        (screen.getByLabelText("Search this Vault locally") as HTMLInputElement)
          .value,
      ).toBe("");
    }
  },
);
it("confirms saved and clears dirty editor before a delayed refresh, then reports refresh failure as saved", async () => {
  const x = await mounted();
  await x.open();
  let fail!: () => void;
  vi.spyOn(x.actor, "list_objects").mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        fail = () => reject(Error("network"));
      }),
  );
  fireEvent.change(screen.getByLabelText("Document title"), {
    target: { value: "Saved first" },
  });
  fireEvent.change(screen.getByLabelText("Private note body"), {
    target: { value: "confirmed body" },
  });
  fireEvent.click(screen.getByText("Save document"));
  await screen.findByText("Saved.");
  expect(x.revisions).toHaveLength(1);
  expect(
    (screen.getByLabelText("Document title") as HTMLInputElement).value,
  ).toBe("");
  expect(
    (screen.getByLabelText("Private note body") as HTMLTextAreaElement).value,
  ).toBe("");
  expect(
    (screen.getByText("Save document") as HTMLButtonElement).disabled,
  ).toBe(true);
  await waitFor(() =>
    expect(
      (screen.getByText("Refresh balance") as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  expect(x.client.hasPendingSave).toBe(false);
  await act(async () => fail());
  await screen.findByText(
    "Saved, but the document list could not be refreshed. Refresh documents to update the list.",
  );
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText("Resume save")).toBeNull();
  expect(x.calls).toHaveLength(1);
});

it("preserves completed body matches when refreshed revisions are unchanged", async () => {
  const x = await mounted();
  await x.open();
  await save();
  fireEvent.change(screen.getByLabelText("Search this Vault locally"), {
    target: { value: "private words" },
  });
  fireEvent.click(screen.getByText("Search note bodies"));
  await screen.findByText("Note body search complete.");
  expect(screen.getByRole("button", { name: "Secret note" })).toBeTruthy();
  const list = vi.spyOn(x.actor, "list_objects");
  const before = list.mock.calls.length;
  fireEvent.click(screen.getByText("Refresh documents"));
  await waitFor(() =>
    expect(list.mock.calls.length).toBeGreaterThan(before),
  );
  expect(screen.getByRole("button", { name: "Secret note" })).toBeTruthy();
  expect(screen.getByText("Note body search complete.")).toBeTruthy();
});
it.each(["close", "unmount"])(
  "ignores a confirmed-save refresh failure after %s",
  async (mode) => {
    const x = await mounted();
    await x.open();
    let fail!: () => void;
    vi.spyOn(x.actor, "list_objects").mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = () => reject(Error("network"));
        }),
    );
    fireEvent.change(screen.getByLabelText("Private note body"), {
      target: { value: "private saved text" },
    });
    fireEvent.click(screen.getByText("Save document"));
    await screen.findByText("Saved.");
    if (mode === "close") fireEvent.click(screen.getByText("Close Vault"));
    else x.view.unmount();
    await act(async () => fail());
    expect(screen.queryByText(/Saved, but/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  },
);

it.each([false, true])(
  "hidden auto-lock clears private state without closing authenticated funding (unlocked=%s)",
  async (unlocked) => {
    const x = await mounted();
    let retained: HTMLInputElement | undefined;
    if (unlocked) {
      await x.open();
      fireEvent.change(screen.getByLabelText("Document title"), {
        target: { value: "private draft" },
      });
      retained = screen.getByLabelText("Document title") as HTMLInputElement;
      expect(x.client.session.root).toBeTruthy();
    } else expect(x.client.session.root).toBeUndefined();
    fireEvent.click(
      screen.getByText("Account & storage", { selector: "summary" }),
    );
    const popup = {
      closed: false,
      close: vi.fn(),
      location: { replace: vi.fn() },
      postMessage: vi.fn(),
    };
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Charge from Wiki credits" })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Charge from Wiki credits" }),
    );
    await waitFor(() => expect(popup.location.replace).toHaveBeenCalled());
    const nonce = new URL(popup.location.replace.mock.calls[0][0]).hash.split(
      "nonce=",
    )[1];
    const generation = x.client.session.capture();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    fireEvent(document, new Event("visibilitychange"));
    await act(async () => {
      vi.setSystemTime(Date.now() + 60_001);
      await new Promise((resolve) => setTimeout(resolve, 1100));
    });
    vi.useRealTimers();
    expect(x.client.session.capture()).toBeGreaterThan(generation);
    expect(x.client.session.root).toBeUndefined();
    if (retained) expect(retained.value).toBe("");
    expect(screen.queryByLabelText("Document title")).toBeNull();
    expect(popup.close).not.toHaveBeenCalled();
    credit.prepare.mockResolvedValue({
      Ok: {
        status: { Prepared: null },
        offer: {
          operation: new Uint8Array(16).fill(4),
          vault_owner: x.client.identity.getPrincipal(),
        },
      },
    });
    fireEvent(
      window,
      new MessageEvent("message", {
        origin: "https://wiki.kinic.xyz",
        source: popup as unknown as Window,
        data: {
          protocol: "kinic-credit-v1",
          type: "offer",
          id: "04".repeat(16),
          nonce,
        },
      }),
    );
    await waitFor(() =>
      expect(popup.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "ready" }),
        "https://wiki.kinic.xyz",
      ),
    );
    x.view.unmount();
    expect(popup.close).toHaveBeenCalledTimes(1);
  },
);

it("shows only live role capabilities for shared Vaults and closes on revocation", async () => {
  const x = await mounted();
  x.setRole(x.headers[1].id, { Editor: null });
  x.setBalance(0n);
  fireEvent.click(screen.getByText("Refresh Vaults"));
  fireEvent.click(await screen.findByText("Vault 2 · Active · Editor"));
  await screen.findByLabelText("Document title");
  await save("Shared note");
  fireEvent.click(screen.getByRole("button", { name: "Shared note" }));
  await screen.findByRole("button", { name: "Delete document" });
  expect(
    screen.queryByText("Permanently delete document and history"),
  ).toBeNull();
  expect(screen.queryByText("Vault members")).toBeNull();
  x.setRole(x.headers[1].id, { Viewer: null });
  fireEvent(window, new Event("focus"));
  await waitFor(() => expect(screen.queryByText("Save document")).toBeNull());
  expect(screen.queryByText("New document")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Shared note" }));
  await screen.findByText("private words");
  expect(screen.queryByText("Delete document")).toBeNull();
  x.setRole(x.headers[1].id, null);
  fireEvent(window, new Event("focus"));
  await screen.findByText("Choose or create a Vault");
  expect(screen.queryByText("private words")).toBeNull();
});

it("lets only the owner add, update, and remove members by Vault principal", async () => {
  const x = await mounted();
  await x.open();
  fireEvent.click(screen.getByText("Vault members"));
  await screen.findByText("No additional members.");
  const guest = Ed25519KeyIdentity.generate().getPrincipal().toText();
  fireEvent.change(screen.getByLabelText("Member Vault principal"), {
    target: { value: guest },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add member" }));
  const member = await screen.findByText(guest);
  const row = within(member.closest("li")!);
  fireEvent.change(row.getByLabelText("Member role"), {
    target: { value: "Editor" },
  });
  await waitFor(async () => {
    const result = await x.actor.list_vault_members(x.headers[0].id);
    expect("Ok" in result && result.Ok[0].role).toEqual({ Editor: null });
  });
  await waitFor(() =>
    expect(
      (row.getByRole("button", { name: "Remove member" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  fireEvent.click(row.getByRole("button", { name: "Remove member" }));
  await waitFor(() => expect(screen.queryByText(guest)).toBeNull());
});

it("loads subsequent accessible Vault pages and fences a revoked cached context", async () => {
  const x = await mounted();
  for (let count = 3; count <= 21; count++) {
    const extra = { ...x.headers[0], id: new Uint8Array(16).fill(count) };
    x.headers.push(extra);
    x.setRole(extra.id, { Viewer: null });
  }
  fireEvent.click(screen.getByText("Refresh Vaults"));
  await waitFor(() =>
    expect(
      (screen.getByText("Refresh Vaults") as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  expect(screen.queryByText("Vault 21 · Active · Viewer")).toBeNull();
  fireEvent.click(screen.getByText("Load more Vaults"));
  fireEvent.click(await screen.findByText("Vault 21 · Active · Viewer"));
  await waitFor(() => expect(x.client.session.root).toBeTruthy());
  await screen.findByText("No documents yet.");
  x.setRole(x.headers[20].id, null);
  fireEvent(window, new Event("focus"));
  await screen.findByText("Choose or create a Vault");
  expect(x.client.session.root).toBeUndefined();
});

it("lets a cold owner remove a member after key service failure without another key request", async () => {
  const x = await mounted();
  const guest = Ed25519KeyIdentity.generate().getPrincipal();
  await x.actor.set_vault_member(x.headers[0].id, guest, { Viewer: null });
  x.failKey(true);
  const derive = vi.spyOn(x.actor, "derive_vault_key");
  fireEvent.click(screen.getByText("Vault 1 · Active"));
  await screen.findByText(/key service is unavailable/);
  expect(screen.queryByLabelText("Document title")).toBeNull();
  fireEvent.click(screen.getByText("Vault members"));
  const row = (await screen.findByText(guest.toText())).closest("li")!;
  fireEvent.click(within(row).getByRole("button", { name: "Remove member" }));
  await screen.findByText("No additional members.");
  expect(await x.actor.list_vault_members(x.headers[0].id)).toEqual({ Ok: [] });
  expect(derive).toHaveBeenCalledTimes(1);
  expect(x.client.session.root).toBeUndefined();
});

it("discards a late member list when the owner selects a different Vault without opening either root", async () => {
  const x = await mounted();
  const [a, b] = [
    Ed25519KeyIdentity.generate().getPrincipal(),
    Ed25519KeyIdentity.generate().getPrincipal(),
  ];
  await x.actor.set_vault_member(x.headers[0].id, a, { Viewer: null });
  await x.actor.set_vault_member(x.headers[1].id, b, { Editor: null });
  const list = x.actor.list_vault_members;
  let release!: () => void;
  vi.spyOn(x.actor, "list_vault_members").mockImplementationOnce(async (id) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return list(id);
  });
  const derive = vi.spyOn(x.actor, "derive_vault_key");
  fireEvent.click(
    screen.getByRole("button", { name: "Manage members of Vault 1" }),
  );
  await waitFor(() => expect(release).toBeTypeOf("function"));
  fireEvent.click(screen.getByText("Close Vault"));
  fireEvent.click(
    screen.getByRole("button", { name: "Manage members of Vault 2" }),
  );
  await screen.findByText(b.toText());
  await act(async () => release());
  expect(screen.queryByText(a.toText())).toBeNull();
  expect(screen.getByText(b.toText())).toBeTruthy();
  expect(derive).not.toHaveBeenCalled();
});

it("refuses member administration for a shared Vault while its key service is unavailable", async () => {
  const x = await mounted();
  x.setRole(x.headers[1].id, { Viewer: null });
  x.failKey(true);
  fireEvent.click(screen.getByText("Refresh Vaults"));
  fireEvent.click(await screen.findByText("Vault 2 · Active · Viewer"));
  await screen.findByText(/key service is unavailable/);
  expect(
    screen.queryByRole("button", { name: "Manage members of Vault 2" }),
  ).toBeNull();
  expect(screen.queryByText("Vault members")).toBeNull();
  const guest = Ed25519KeyIdentity.generate().getPrincipal();
  await expect(x.client.listMembers()).rejects.toThrow("Unauthorized");
  await expect(x.client.removeMember(guest)).rejects.toThrow("Unauthorized");
});

it("closes the previous private view when reopening its selected owner header fails", async () => {
  const x = await mounted();
  await x.open();
  const input = screen.getByLabelText("Document title") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "unsaved private title" } });
  vi.spyOn(x.actor, "get_vault_header").mockRejectedValueOnce(
    Error("NetworkUnavailable"),
  );
  fireEvent.click(screen.getByText("Vault 1 · Active"));
  await screen.findByText("Retry opening Vault");
  expect(input.value).toBe("");
  expect(screen.queryByLabelText("Document title")).toBeNull();
  expect(x.client.session.root).toBeUndefined();
  expect(screen.getByText("Vault members")).toBeTruthy();
});
