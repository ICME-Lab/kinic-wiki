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
import { VaultFundingProvider } from "../funding/session";
vi.mock("../funding/adapter", async original => ({
  ...await original<object>(), discoverVaultFundingConfig: async () => null, listVaultFundingHistory: async () => [],
}));
function workspace(client: VaultClient) {
  const config = {canister:client.canister, host:"http://localhost:4943", origin:location.origin, local:true,
    identityProvider:"http://id.localhost",derivationOrigin:"http://" + client.canister + ".localhost",fundingMode:"unavailable" as const};
  return <VaultFundingProvider config={config} identity={client.identity}><VaultWorkspace client={client}/></VaultFundingProvider>;
}
HTMLDialogElement.prototype.showModal = function () { this.open = true; };
HTMLDialogElement.prototype.close = function () { this.open = false; };
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function clickAndDiscard(element:HTMLElement){
 fireEvent.click(element);
 const dialog=screen.queryByRole("dialog",{name:"Discard unsaved changes?"});
 if(dialog) fireEvent.click(within(dialog).getByRole("button",{name:"Discard changes"}));
}
async function mounted() {
  const network = fixtureNetwork();
  const client = new VaultClient({
    actor: network.actor,
    identity: Ed25519KeyIdentity.generate(),
    canister: "rrkah-fqaaa-aaaaa-aaaaq-cai",
    local: true,
  });
  const view = render(workspace(client));
  await screen.findByText("Vault 1");
  const open = async (n = 1) => {
    clickAndDiscard(screen.getByText(`Vault ${n}`));
    await screen.findByLabelText("Document title");
    await waitFor(() =>
      expect(
        (screen.getByText("Refresh Vaults") as HTMLButtonElement).disabled,
      ).toBe(false),
    );
  };
  return { ...network, client, view, open };
}
async function openVaultSettings(name = "Vault 1") {
  fireEvent.keyDown(screen.getByRole("button", { name: `Actions for ${name}` }), { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Vault settings" }));
  await screen.findByRole("region", { name: `${name} settings` });
}
it("keeps account settings separate and deletes a different Vault without switching the open draft", async () => {
  const x = await mounted();
  await x.open();
  fireEvent.change(screen.getByLabelText("Private note body"), { target: { value: "keep my draft" } });
  const root = x.client.session.root;
  fireEvent.click(screen.getByRole("button", { name: "Account settings" }));
  const account = await screen.findByRole("region", { name: "Account settings" });
  expect(within(account).queryByText("Permanently delete this Vault")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Back to Vault" }));
  const secondId = x.headers[1].id;
  await openVaultSettings("Vault 2");
  const settings = screen.getByRole("region", { name: "Vault 2 settings" });
  expect(within(settings).queryByText("Saved browser keys")).toBeNull();
  fireEvent.change(within(settings).getByLabelText("Type Vault 2 to confirm"), { target: { value: "Vault 1" } });
  expect(within(settings).getByText("Permanently delete this Vault")).toHaveProperty("disabled", true);
  fireEvent.change(within(settings).getByLabelText("Type Vault 2 to confirm"), { target: { value: "Vault 2" } });
  fireEvent.click(within(settings).getByText("Permanently delete this Vault"));
  await waitFor(() => expect(x.headers).toHaveLength(1));
  expect(x.headers.some(h => String(h.id) === String(secondId))).toBe(false);
  expect(x.client.session.root).toBe(root);
  fireEvent.click(screen.getByRole("button", { name: "Back to Vault" }));
  expect(screen.getByLabelText("Private note body")).toHaveProperty("value", "keep my draft");
});
async function save(title = "Secret note", body = "private words") {
  fireEvent.change(screen.getByLabelText("Document title"), {
    target: { value: title },
  });
  fireEvent.change(screen.getByLabelText("Private note body"), {
    target: { value: body },
  });
  clickAndDiscard(screen.getByText("Save document"));
  await screen.findByRole("button", { name: title });
  await waitFor(() =>
    expect(
      (screen.getByText("Refresh balance") as HTMLButtonElement).disabled,
    ).toBe(false),
  );
}
async function requestDocumentDeletion(title: string, permanent = false) {
  const trigger = screen.getByRole("button", { name: `Actions for ${title}` });
  await waitFor(() => expect(trigger).toHaveProperty("disabled", false));
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  const item = await screen.findByRole("menuitem", { name: permanent ? "Permanently delete document and history" : "Delete document" });
  fireEvent.click(item);
  const discard = screen.queryByRole("dialog", { name: "Discard unsaved changes?" });
  if (discard) fireEvent.click(within(discard).getByRole("button", { name: "Discard changes" }));
  return screen.findByRole("dialog", { name: permanent ? "Permanently delete document and history" : "Delete document" });
}
it("renames a closed Vault without retrieving a key and retains the name on refresh", async () => {
  const x = await mounted();
  const derive = vi.spyOn(x.client.actor, "derive_vault_key");
  fireEvent.keyDown(screen.getByRole("button", { name: "Actions for Vault 1" }), { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Rename Vault" }));
  const dialog = await screen.findByRole("dialog", { name: "Rename Vault" });
  const input = within(dialog).getByLabelText("Vault name");
  fireEvent.change(input, { target: { value: " " } });
  expect(within(dialog).getByRole("button", { name: "Save name" })).toHaveProperty("disabled", true);
  fireEvent.change(input, { target: { value: "仕事" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save name" }));
  await screen.findByRole("button", { name: "仕事" });
  expect(derive).not.toHaveBeenCalled();
  clickAndDiscard(screen.getByText("Refresh Vaults"));
  await screen.findByRole("button", { name: "仕事" });
  fireEvent.click(screen.getByRole("button", { name: "仕事" }));
  await screen.findByLabelText("Document title");
  await openVaultSettings("仕事");
  expect(screen.getByLabelText("Type 仕事 to confirm")).toBeTruthy();
});
it("retries a lost rename response while closed using the same operation", async () => {
  const x = await mounted();
  const original = x.client.actor.mutate.bind(x.client.actor);
  let lost = true;
  vi.spyOn(x.client.actor, "mutate").mockImplementation(async mutation => {
    const result = await original(mutation);
    if (lost && "RenameVault" in mutation.action) { lost = false; throw Error("network"); }
    return result;
  });
  const trigger = screen.getByRole("button", { name: "Actions for Vault 1" });
  await waitFor(() => expect(trigger).toHaveProperty("disabled", false));
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Rename Vault" }));
  const dialog = await screen.findByRole("dialog", { name: "Rename Vault" });
  fireEvent.change(within(dialog).getByLabelText("Vault name"), { target: { value: "Personal" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save name" }));
  clickAndDiscard(await screen.findByRole("button", { name: "Retry interrupted change" }));
  await screen.findByRole("button", { name: "Personal" });
  const calls = x.calls.filter(call => "RenameVault" in call.action);
  expect(calls).toHaveLength(2);
  expect(calls[0]).toEqual(calls[1]);
  expect(x.headers[0].sequence).toBe(1n);
});
async function confirmDocumentDeletion(title: string, permanent = false) {
  const dialog = await requestDocumentDeletion(title, permanent);
  fireEvent.change(within(dialog).getByLabelText("Type delete to confirm"), { target: { value: "delete" } });
  fireEvent.click(within(dialog).getByRole("button", { name: permanent ? "Permanently delete document and history" : "Delete document" }));
}
it("deletes only the document chosen from its card and requires exact delete confirmation", async () => {
  const x = await mounted(); await x.open();
  await save("Keep", "keep body");
  clickAndDiscard(screen.getByText("New document"));
  await save("Remove", "remove body");
  expect(screen.queryByRole("button", { name: "Delete document" })).toBeNull();
  expect(screen.queryByText("Document settings")).toBeNull();
  const dialog = await requestDocumentDeletion("Keep");
  const submit = within(dialog).getByRole("button", { name: "Delete document" });
  const input = within(dialog).getByLabelText("Type delete to confirm");
  expect(submit).toHaveProperty("disabled", true);
  fireEvent.change(input, { target: { value: "DELETE" } });
  expect(submit).toHaveProperty("disabled", true);
  fireEvent.change(input, { target: { value: "delete" } });
  fireEvent.click(submit);
  await screen.findByRole("button", { name: "Keep (deleted)" });
  expect(screen.getByLabelText("Document title")).toHaveProperty("value", "Remove");
  expect(screen.getByLabelText("Private note body")).toHaveProperty("value", "remove body");
  expect(x.revisions.some(revision => revision.deleted)).toBe(true);
});
it.each([false, true])("invalidates retained document deletion confirmation on lock (permanent=%s)", async permanent => {
  const x = await mounted(); await x.open(); await save("Private target", "private body");
  const remove = vi.spyOn(x.client, permanent ? "purgeObject" : "deleteObject");
  const dialog = await requestDocumentDeletion("Private target", permanent);
  fireEvent.change(within(dialog).getByLabelText("Type delete to confirm"), { target: { value: "delete" } });
  const submit = within(dialog).getByRole("button", { name: permanent ? "Permanently delete document and history" : "Delete document" });
  act(() => { x.client.session.lock(); fireEvent.click(submit); });
  expect(remove).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).toBeNull();
});
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
  clickAndDiscard(screen.getByText("New document"));
  clickAndDiscard(screen.getByRole("button", { name: "Secret note" }));
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
  clickAndDiscard(screen.getByText("Refresh Vaults"));
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
  fireEvent.click(screen.getByText("Search note contents"));
  await screen.findByText("Note body search complete.");
  expect(screen.getByRole("button", { name: "Secret note" })).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Search this Vault locally"), {
    target: { value: "absent" },
  });
  expect(screen.queryByRole("button", { name: "Secret note" })).toBeNull();
});
it("keeps the saved note in the editor and saves further edits as revisions of the same document", async () => {
  const x = await mounted();
  await x.open();
  const editor = screen.getByLabelText("Private note body");
  await save("Working note", "first draft");
  expect(screen.getByLabelText("Document title")).toHaveProperty("value", "Working note");
  expect(screen.getByLabelText("Private note body")).toBe(editor);
  expect(editor).toHaveProperty("value", "first draft");
  expect(screen.getByText("Save document")).toHaveProperty("disabled", true);
  const object = x.revisions.at(-1)!.object;
  await save("Working note", "second draft");
  await save("Renamed note", "third draft");
  expect(x.revisions.at(-1)!.object).toEqual(object);
  expect(x.revisions.at(-1)!.revision).toBe(3n);
  expect((await x.client.items())).toHaveLength(1);
  const doc = await x.client.read(x.revisions.at(-1)!);
  expect(doc.metadata.title).toBe("Renamed note");
  expect(new TextDecoder().decode(doc.plaintext)).toBe("third draft");
  doc.plaintext.fill(0);
});
it("retries exact create after refresh and key failure without duplicating a Vault", async () => {
  const x = await mounted();
  x.loseCreate();
  clickAndDiscard(screen.getByText("Create Vault"));
  await screen.findByRole("alert");
  clickAndDiscard(screen.getByText("Refresh Vaults"));
  await waitFor(() =>
    expect(
      (screen.getByText("Retry Vault creation") as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  await x.open(2);
  expect(screen.getByText("Retry Vault creation")).toBeTruthy();
  x.failKey(true);
  clickAndDiscard(screen.getByText("Retry Vault creation"));
  await screen.findByText(/key service is unavailable/);
  expect(x.creation).toHaveLength(2);
  expect(x.creation[0]).toEqual(x.creation[1]);
  expect(x.headers).toHaveLength(3);
  x.failKey(false);
  clickAndDiscard(screen.getByText("Retry opening Vault"));
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
it("views a historical revision read-only and downloads the displayed version through the common action", async () => {
  const x = await mounted();
  await x.open();
  await save("Original title", "original body");
  await save("Latest title", "latest body");
  clickAndDiscard(screen.getByText("Show version history"));
  const view = await screen.findByRole("button", { name: "View revision 1" });
  expect(screen.queryByText("Download revision 1")).toBeNull();
  clickAndDiscard(view);
  await waitFor(() => expect(screen.getByLabelText("Private note body")).toHaveProperty("value", "original body"));
  expect(screen.getByLabelText("Document title")).toHaveProperty("value", "Original title");
  expect(screen.getByLabelText("Document title")).toHaveProperty("disabled", true);
  expect(screen.getByText("Save document")).toHaveProperty("disabled", true);
  const downloads: { body: string; filename: string }[] = [];
  vi.spyOn(x.client.session, "download").mockImplementation((data, filename) => {
    downloads.push({ body: new TextDecoder().decode(data), filename });
  });
  await waitFor(() => expect(screen.getByText("Download document")).toHaveProperty("disabled", false));
  clickAndDiscard(screen.getByText("Download document"));
  await waitFor(() => expect(downloads).toHaveLength(1));
  expect(downloads[0].body).toBe("original body");
  expect(downloads[0].filename).toContain("revision-1");
  clickAndDiscard(screen.getByRole("button", { name: "Return to latest version" }));
  await waitFor(() => expect(screen.getByLabelText("Private note body")).toHaveProperty("value", "latest body"));
  expect(screen.getByLabelText("Document title")).toHaveProperty("disabled", false);
  clickAndDiscard(screen.getByText("Download document"));
  await waitFor(() => expect(downloads).toHaveLength(2));
  expect(downloads[1].body).toBe("latest body");
  expect(downloads[1].filename).toContain("revision-2");
});
it("retains history after ordinary deletion and purges the document and history", async () => {
  const x = await mounted();
  await x.open();
  await save();
  clickAndDiscard(screen.getByRole("button", { name: "Secret note" }));
  await waitFor(() => expect(screen.getByText("Show version history")).toHaveProperty("disabled", false));
  clickAndDiscard(screen.getByText("Show version history"));
  await screen.findByText("Revision 1");
  await confirmDocumentDeletion("Secret note");
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
  clickAndDiscard(
    screen.getByRole("button", { name: "Secret note (deleted)" }),
  );
  await waitFor(() =>
    expect(
      (screen.getByText("Show version history") as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  clickAndDiscard(screen.getByText("Show version history"));
  await screen.findByRole("button", { name: "View revision 1" });
  await confirmDocumentDeletion("Secret note", true);
  await waitFor(() => expect(x.revisions).toHaveLength(0));
  await screen.findByText(
    "No documents yet. Create a note, credential or attachment.",
  );
});
it("cleans orphan uploads and purges an entire Vault with zero balance", async () => {
  const x = await mounted();
  await x.open();
  expect(screen.queryByRole("region", { name: "Interrupted uploads" })).toBeNull();
  expect(screen.queryByText("Interrupted uploads")).toBeNull();
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
  clickAndDiscard(screen.getByText("Refresh balance"));
  await screen.findByLabelText("Prepaid balance: 0 cycles");
  clickAndDiscard(screen.getByText("Refresh Vaults"));
  const recovery = await screen.findByRole("region", { name: "Interrupted uploads" });
  expect(recovery.closest("details")).toBeNull();
  const cancel = await screen.findByText("Cancel interrupted upload 1");
  clickAndDiscard(cancel);
  await waitFor(() => expect(x.uploads.size).toBe(0));
  await waitFor(() => expect(screen.queryByRole("region", { name: "Interrupted uploads" })).toBeNull());
  await openVaultSettings();
  fireEvent.change(screen.getByLabelText("Type Vault 1 to confirm"), { target: { value: "Vault 1" } });
  clickAndDiscard(screen.getByText("Permanently delete this Vault"));
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
    clickAndDiscard(screen.getByRole("button", { name: "Secret note" }));
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    if (action === "unmount") x.view.unmount();
    else {
      clickAndDiscard(screen.getByText("Close Vault"));
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
    clickAndDiscard(screen.getByText("Refresh Vaults"));
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
  clickAndDiscard(screen.getByText("Save document"));
  await screen.findByRole("button", { name: "Login" });
  clickAndDiscard(screen.getByRole("button", { name: "Login" }));
  await waitFor(() =>
    expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe(
      "secret",
    ),
  );
  await waitFor(() => expect(screen.getByText("Show password")).toHaveProperty("disabled", false));
  clickAndDiscard(screen.getByText("Show password"));
  expect(screen.getByLabelText("Password").getAttribute("type")).toBe("text");
  clickAndDiscard(screen.getByText("New document"));
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
  clickAndDiscard(screen.getByText("Save document"));
  await screen.findByRole("button", { name: "File" });
  const doc = await x.client.read(x.revisions.at(-1)!);
  expect(doc.metadata.filename).toBe("note.txt");
  expect(new TextDecoder().decode(doc.plaintext)).toBe("file bytes");
  doc.plaintext.fill(0);
});
it("keeps a hidden Vault open until 30 minutes idle, then clears private data", async () => {
  const x = await mounted();
  await x.open();
  const revoke = vi.fn();
  vi.stubGlobal("URL", Object.assign(URL, { revokeObjectURL: revoke }));
  x.client.session.urls.add("blob:private");
  await act(async () => {
    x.client.session.visible(true);
    x.client.session.expire(x.client.session.lastActivity + 60001);
  });
  expect(revoke).not.toHaveBeenCalled();
  expect(screen.queryByLabelText("Document title")).not.toBeNull();
  await act(async () => {
    x.client.session.expire(x.client.session.lastActivity + 30 * 60 * 1000);
  });
  expect(revoke).toHaveBeenCalledWith("blob:private");
  expect(screen.queryByLabelText("Document title")).toBeNull();
});
it("shows account and storage in settings without an empty upload recovery section", async () => {
  await mounted();
  expect(screen.queryByRole("region", { name: "Account settings" })).toBeNull();
  const accountSummary = screen.getByText("Account & storage").closest("summary")!;
  expect(accountSummary.closest("[hidden]")).not.toBeNull();
  clickAndDiscard(screen.getByRole("button", { name: "Account settings" }));
  const settings = screen.getByRole("region", { name: "Account settings" });
  expect(within(settings).getByText("Account & storage")).toBeTruthy();
  clickAndDiscard(accountSummary);
  expect(within(settings).getByRole("region", { name: "Vault account" })).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Interrupted uploads", hidden: true })).toBeNull();
  clickAndDiscard(screen.getByRole("button", { name: "Back to Vault" }));
  expect(accountSummary.closest("[hidden]")).not.toBeNull();
});
it("opens account funding in settings from the low balance action", async () => {
  const x = await mounted();
  await x.open();
  x.setBalance(0n);
  clickAndDiscard(screen.getByText("Refresh balance"));
  await screen.findByLabelText("Prepaid balance: 0 cycles");
  clickAndDiscard(screen.getByRole("button", { name: "Add balance to create a Vault" }));
  const settings = screen.getByRole("region", { name: "Account settings" });
  const summary = within(settings).getByText("Account & storage").closest("summary")!;
  expect(summary.closest("details")?.open).toBe(true);
  expect(within(settings).getByRole("button", { name: "Review payment" })).toBeTruthy();
  await waitFor(() => expect(document.activeElement).toBe(summary));
});
it("keeps production funding disabled", async () => {
  await mounted();
  clickAndDiscard(screen.getByRole("button", { name: "Account settings" }));
  clickAndDiscard(
    screen.getByText("Account & storage").closest("summary")!,
  );
  const account = screen.getByRole("region", { name: "Vault account" });
  expect(
    (within(account).getByText("Review payment") as HTMLButtonElement).disabled,
  ).toBe(true);
});
it.each(["Pending", "Deleting"] as const)(
  "allows cleanup of a %s header after reload without requesting a key",
  async (state) => {
    const x = await mounted();
    x.headers[0].state =
      state === "Pending" ? { Pending: null } : { Deleting: null };
    clickAndDiscard(screen.getByText("Refresh Vaults"));
    await screen.findByText(`Vault 1 · ${state}`);
    const derive = vi.spyOn(x.actor, "derive_vault_key");
    clickAndDiscard(screen.getByText(`Vault 1 · ${state}`));
    await screen.findByText(
      `This Vault is ${state.toLowerCase()}. Use this Vault’s actions menu to remove its unfinished data.`,
    );
    await openVaultSettings();
    fireEvent.change(screen.getByLabelText("Type Vault 1 to confirm"), { target: { value: "Vault 1" } });
  clickAndDiscard(screen.getByText("Permanently delete this Vault"));
    await waitFor(() => expect(x.headers).toHaveLength(1));
    expect(derive).not.toHaveBeenCalled();
    expect(x.client.session.root).toBeUndefined();
  },
);
it("retains the draft after definitive optimistic conflict and permits reopening the current version", async () => {
  const x = await mounted();
  await x.open();
  await save();
  clickAndDiscard(screen.getByRole("button", { name: "Secret note" }));
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
  clickAndDiscard(screen.getByText("Save document"));
  await screen.findByText(/Another update changed/);
  expect(
    (screen.getByLabelText("Private note body") as HTMLTextAreaElement).value,
  ).toBe("conflicting draft");
  expect(x.client.hasPendingSave).toBe(false);
  fireEvent.click(screen.getByRole("button", {name:"Refresh documents"}));
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "Secret note" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  clickAndDiscard(screen.getByRole("button", { name: "Secret note" }));
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
  clickAndDiscard(screen.getByText("Vault 1"));
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  await act(async () => x.client.session.expire(x.client.session.lastActivity + 30 * 60 * 1000));
  await act(async () => finish());
  expect(x.client.session.root).toBeUndefined();
  expect(screen.queryByLabelText("Document title")).toBeNull();
});
it("closes a failed key attempt when its header disappears on refresh", async () => {
  const x = await mounted();
  x.failKey(true);
  clickAndDiscard(screen.getByText("Vault 1"));
  await screen.findByRole("alert");
  const ticket = x.client.session.capture();
  x.headers.shift();
  clickAndDiscard(screen.getByText("Refresh Vaults"));
  await waitFor(() =>
    expect(x.client.session.capture()).toBeGreaterThan(ticket),
  );
  expect(screen.queryByText("Retry opening Vault")).toBeNull();
});

it("keeps the open draft and root when the account disclosure is toggled", async () => {
  const x = await mounted();
  await x.open();
  fireEvent.change(screen.getByLabelText("Private note body"), {
    target: { value: "unsaved private draft" },
  });
  const root = x.client.session.root;
  const ticket = x.client.session.capture();
  for (const name of ["Account & storage"]) {
    if (name === "Account & storage")
      clickAndDiscard(screen.getByRole("button", { name: "Account settings" }));
    const summary = screen.getByText(name).closest("summary")!;
    clickAndDiscard(summary);
    expect(summary.closest("details")?.open).toBe(true);
    expect(x.client.session.root).toBe(root);
    expect(x.client.session.capture()).toBe(ticket);
    expect(screen.getByDisplayValue("unsaved private draft")).toBeTruthy();
    if (name === "Account & storage")
      clickAndDiscard(screen.getByRole("button", { name: "Back to Vault" }));
  }
  clickAndDiscard(screen.getByRole("button", { name: "Close Vault" }));
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
  clickAndDiscard(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(x.client.session.root).toBe(root);
  expect(screen.getByDisplayValue("private draft")).toBeTruthy();
  clickAndDiscard(screen.getByRole("button", { name: "Vault 2" }));
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
it("shows funding directly beside the first Vault creation step at zero balance", async () => {
  const x = await mounted();
  x.setBalance(0n);
  clickAndDiscard(screen.getByText("Refresh balance"));
  await screen.findByLabelText("Prepaid balance: 0 cycles");
  expect((screen.getByRole("button", { name: /^Create Vault$/ }) as HTMLButtonElement).disabled).toBe(true);
  const summary = screen.getByText("Account & storage");
  const details = summary.closest("details")!;
  expect(details.open).toBe(false);
  const setup = screen.getByRole("region", { name: "Choose a Vault" });
  expect(within(setup).getByLabelText("KINIC amount")).toBeTruthy();
  expect(within(setup).getByRole("button", { name: "Review payment" })).toBeTruthy();
  expect(details.open).toBe(false);
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
  clickAndDiscard(screen.getByText("Save document"));
  await screen.findByRole("alert");
  expect((screen.getByText("Resume save") as HTMLButtonElement).disabled).toBe(
    false,
  );
  clickAndDiscard(screen.getByText("Resume save"));
  await waitFor(() => expect(x.client.hasPendingSave).toBe(false));
  await waitFor(() =>
    expect(
      (screen.getByText("Refresh balance") as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  x.setBalance(26_253_846_153n);
  clickAndDiscard(screen.getByText("Refresh balance"));
  await screen.findByLabelText("Prepaid balance: 26,253,846,153 cycles");
  // A balance covering key retrieval is advisory: the server owns fee/execution admission.
  vi.spyOn(x.actor, "create_vault").mockResolvedValue({
    Err: { QuotaExceeded: null },
  });
  clickAndDiscard(screen.getByText("Create Vault"));
  await screen.findByRole("alert");
  expect(x.actor.create_vault).toHaveBeenCalledOnce();
  await waitFor(() =>
    expect(
      (screen.getByText("Refresh balance") as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  x.setBalance(0n);
  clickAndDiscard(screen.getByText("Refresh balance"));
  await screen.findByLabelText("Prepaid balance: 0 cycles");
  expect(
    (screen.getByText("Retry Vault creation") as HTMLButtonElement).disabled,
  ).toBe(true);
});
it("purges a selected document and its history at zero credit while retaining another", async () => {
  const x = await mounted();
  await x.open();
  await save("Keep", "retained body");
  clickAndDiscard(screen.getByText("New document"));
  await save("Remove", "old body");
  clickAndDiscard(screen.getByRole("button", { name: "Remove" }));
  await waitFor(() =>
    expect(
      (screen.getByLabelText("Private note body") as HTMLTextAreaElement).value,
    ).toBe("old body"),
  );
  await save("Remove", "new body");
  clickAndDiscard(screen.getByRole("button", { name: "Remove" }));
  await screen.findByText("Show version history");
  x.setBalance(0n);
  clickAndDiscard(screen.getByText("Refresh balance"));
  await screen.findByLabelText("Prepaid balance: 0 cycles");
  expect(screen.getByText("Save document")).toHaveProperty("disabled", true);
  const trigger = screen.getByRole("button", { name: "Actions for Remove" });
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  const ordinary = await screen.findByRole("menuitem", { name: "Delete document" });
  expect(ordinary.hasAttribute("data-disabled")).toBe(true);
  fireEvent.click(screen.getByRole("menuitem", { name: "Permanently delete document and history" }));
  const dialog = await screen.findByRole("dialog", { name: "Permanently delete document and history" });
  fireEvent.change(within(dialog).getByLabelText("Type delete to confirm"), { target: { value: "delete" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Permanently delete document and history" }));
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
    clickAndDiscard(screen.getByText("Refresh balance"));
    await screen.findByLabelText("Prepaid balance: 0 cycles");
    clickAndDiscard(screen.getByText("Refresh Vaults"));
    await waitFor(() =>
      expect(
        (screen.getByText("Refresh Vaults") as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    clickAndDiscard(
      screen.getByText(
        state === "failed-open" ? "Vault 1" : `Vault 1 · ${state}`,
      ),
    );
    clickAndDiscard(screen.getByRole("button", { name: "Account settings" }));
    await screen.findByText("Storage maintenance");
    await waitFor(() =>
      expect(
        (screen.getByText("Free up unused storage") as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    x.lose("Collect");
    clickAndDiscard(screen.getByText("Storage maintenance"));
    clickAndDiscard(screen.getByText("Free up unused storage"));
    await waitFor(() => expect(x.calls).toHaveLength(1));
    await waitFor(() =>
      expect(
        (screen.getByText("Free up unused storage") as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    clickAndDiscard(screen.getByText("Free up unused storage"));
    await screen.findByText("Storage maintenance complete");
    expect(x.calls[0]).toEqual(x.calls[1]);
    expect(x.client.session.root).toBeUndefined();
    await waitFor(() =>
      expect(
        (screen.getByText("Free up unused storage") as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    clickAndDiscard(screen.getByText("Free up unused storage"));
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
  clickAndDiscard(screen.getByText("Cancel save"));
  await waitFor(() =>
    expect(x.calls.filter((m) => "CancelUpload" in m.action)).toHaveLength(1),
  );
  await waitFor(() =>
    expect(
      (screen.getByText("Cancel save") as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  expect(x.client.hasPendingSave).toBe(true);
  clickAndDiscard(screen.getByText("Cancel save"));
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
  clickAndDiscard(screen.getByText("Vault 1"));
  await waitFor(() => expect(finishOld).toBeTypeOf("function"));
  clickAndDiscard(screen.getByText("Close Vault"));
  clickAndDiscard(screen.getByText("Vault 2"));
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

it("initializes a free account before allowing creation and retries a lost initialization", async () => {
  const network=fixtureNetwork();
  network.setBalance(10_000_000_000n);
  network.setFirstKeyFree(true);
  let resolve!: (value: Awaited<ReturnType<typeof network.actor.initialize_vault_account>>) => void;
  vi.spyOn(network.actor,"initialize_vault_account").mockImplementation(() => new Promise((r)=>{resolve=r;}));
  const client=new VaultClient({actor:network.actor,identity:Ed25519KeyIdentity.generate(),canister:"rrkah-fqaaa-aaaaa-aaaaq-cai",local:true});
  render(workspace(client));
  await screen.findByText("Preparing your Vault account…");
  expect((screen.getByText("Create Vault") as HTMLButtonElement).disabled).toBe(true);
  await act(async()=>resolve({Ok:{balance:10_000_000_000n,grant_cycles:10_000_000_000n}}));
  await screen.findByLabelText("Prepaid balance: 10,000,000,000 cycles");
  expect((screen.getByText("Create your Vault") as HTMLButtonElement).disabled).toBe(false);
});
it("offers retry after account initialization loses its reply", async()=>{
  const network=fixtureNetwork();
  const initialize=vi.spyOn(network.actor,"initialize_vault_account").mockRejectedValueOnce(Error("network"));
  const client=new VaultClient({actor:network.actor,identity:Ed25519KeyIdentity.generate(),canister:"rrkah-fqaaa-aaaaa-aaaaq-cai",local:true});
  render(workspace(client));
  clickAndDiscard(await screen.findByRole("button",{name:"Retry account setup"}));
  await screen.findByRole("button",{name:"Create your Vault"});
  expect(initialize).toHaveBeenCalledTimes(2);
});

it("offers inline funding instead of creating a Vault that cannot afford its first key",async()=>{
  const x=await mounted();
  x.setBalance(23_000_000_000n);
  clickAndDiscard(screen.getByText("Refresh balance"));
  await screen.findByLabelText("Prepaid balance: 23,000,000,000 cycles");
  expect((screen.getByRole("button",{name:/^Create Vault$/}) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByLabelText("Prepaid balance: 23,000,000,000 cycles").classList.contains("bg-warnSoft")).toBe(true);
  const setup=screen.getByRole("region",{name:"Choose a Vault"});
  expect(within(setup).getByLabelText("KINIC amount")).toBeTruthy();
  expect(x.creation).toHaveLength(0);
});
it("refreshes the balance after a charged key retrieval",async()=>{
  const x=await mounted();
  const derive=x.actor.derive_vault_key;
  vi.spyOn(x.actor,"derive_vault_key").mockImplementation(async(...args)=>{
    x.setBalance(23_000_000_000n);
    return derive(...args);
  });
  await x.open();
  await screen.findByLabelText("Prepaid balance: 23,000,000,000 cycles");
});
it("funds a missing key inline and retries opening without creating another Vault",async()=>{
  const x=await mounted();
  x.setBalance(23_000_000_000n);
  clickAndDiscard(screen.getByText("Refresh balance"));
  await screen.findByLabelText("Prepaid balance: 23,000,000,000 cycles");
  const derive=vi.spyOn(x.actor,"derive_vault_key");
  clickAndDiscard(screen.getByRole("button",{name:"Vault 1"}));
  await screen.findByText(/Add prepaid balance here to retrieve/);
  expect(screen.getByLabelText("Prepaid balance: 23,000,000,000 cycles").classList.contains("bg-warnSoft")).toBe(true);
  const panel=screen.getByRole("region",{name:"Open Vault"});
  expect(within(panel).getByLabelText("KINIC amount")).toBeTruthy();
  expect(derive).not.toHaveBeenCalled();
  x.setBalance(50_000_000_000n);
  clickAndDiscard(screen.getByText("Refresh balance"));
  await waitFor(()=>expect((screen.getByText("Retry opening Vault") as HTMLButtonElement).disabled).toBe(false));
  expect(screen.getByLabelText("Prepaid balance: 50,000,000,000 cycles").classList.contains("bg-okSoft")).toBe(true);
  clickAndDiscard(screen.getByText("Retry opening Vault"));
  await screen.findByLabelText("Document title");
  expect(derive).toHaveBeenCalledTimes(1);
  expect(x.creation).toHaveLength(0);
});
it("keeps an already open key usable at zero credit while disabling new writes",async()=>{
  const x=await mounted();
  await x.open();
  const root=x.client.session.root;
  x.setBalance(0n);
  clickAndDiscard(screen.getByText("Refresh balance"));
  await screen.findByLabelText("Prepaid balance: 0 cycles");
  const derive=vi.spyOn(x.actor,"derive_vault_key");
  await x.open();
  expect(x.client.session.root).toBe(root);
  expect(derive).not.toHaveBeenCalled();
  expect((screen.getByText("Save document") as HTMLButtonElement).disabled).toBe(true);
});
it("refreshes credit after a failed paid operation too",async()=>{
  const x=await mounted();
  vi.spyOn(x.actor,"create_vault").mockImplementation(async()=>{
    x.setBalance(0n);
    return {Err:{QuotaExceeded:null}};
  });
  clickAndDiscard(screen.getByText("Create Vault"));
  await screen.findByRole("alert");
  await screen.findByLabelText("Prepaid balance: 0 cycles");
  expect((screen.getByText("Retry Vault creation") as HTMLButtonElement).disabled).toBe(true);
});
it("prices the selected Vault key rather than the current default key",async()=>{
  const x=await mounted();
  x.setBalance(29_000_000_000n);
  const cost=vi.spyOn(x.actor,"vault_key_cost").mockImplementation(async(key)=>({Ok:{fee:key[0]?30_000_000_000n:1_000_000_000n,owner_fee:key[0]?30_000_000_000n:1_000_000_000n,first_key_free:false}}));
  clickAndDiscard(screen.getByText("Refresh balance"));
  await screen.findByLabelText("Prepaid balance: 29,000,000,000 cycles");
  const derive=vi.spyOn(x.actor,"derive_vault_key");
  clickAndDiscard(screen.getByRole("button",{name:"Vault 1"}));
  await screen.findByText(/Add prepaid balance here to retrieve/);
  expect(cost).toHaveBeenCalledWith(["test_key_1"]);
  expect(derive).not.toHaveBeenCalled();
  expect(within(screen.getByRole("region",{name:"Open Vault"})).getByLabelText("KINIC amount")).toBeTruthy();
});
it("retries a zero-grant initialization on a later account refresh",async()=>{
  const x=await mounted();
  vi.spyOn(x.actor,"initialize_vault_account").mockImplementationOnce(async()=>{
    x.setBalance(10_000_000_000n);
    return {Ok:{balance:10_000_000_000n,grant_cycles:10_000_000_000n}};
  });
  clickAndDiscard(screen.getByText("Refresh balance"));
  await screen.findByLabelText("Prepaid balance: 10,000,000,000 cycles");
});
it("keeps an affordable exact creation retry enabled after a lost reply",async()=>{
  const x=await mounted();
  const fee=26_153_846_153n;
  x.setBalance(fee+50_000_000n);
  clickAndDiscard(screen.getByText("Refresh balance"));
  await screen.findByLabelText(`Prepaid balance: ${(fee+50_000_000n).toLocaleString("en-US")} cycles`);
  const create=x.actor.create_vault;
  vi.spyOn(x.actor,"create_vault").mockImplementationOnce(async(request)=>{
    x.setBalance(fee+25_000_000n);
    x.loseCreate();
    return create(request);
  });
  clickAndDiscard(screen.getByText("Create Vault"));
  await screen.findByRole("alert");
  await screen.findByLabelText(`Prepaid balance: ${(fee+25_000_000n).toLocaleString("en-US")} cycles`);
  await waitFor(()=>expect((screen.getByText("Refresh balance") as HTMLButtonElement).disabled).toBe(false));
  const retry=screen.getByRole("button",{name:"Retry Vault creation"}) as HTMLButtonElement;
  expect(retry.disabled).toBe(false);
  clickAndDiscard(retry);
  await screen.findByLabelText("Document title");
  expect(x.creation).toHaveLength(2);
  expect(x.creation[0]).toEqual(x.creation[1]);
  expect(x.headers).toHaveLength(3);
});
it("creates the first Vault with 10B and a sponsored key, then gates later paid retrievals",async()=>{
  const network=fixtureNetwork();
  network.headers.length=0;
  network.setBalance(10_000_000_000n);
  network.setFirstKeyFree(true);
  vi.spyOn(network.actor,"initialize_vault_account").mockResolvedValue({Ok:{balance:10_000_000_000n,grant_cycles:10_000_000_000n}});
  const derive=vi.spyOn(network.actor,"derive_vault_key");
  const client=new VaultClient({actor:network.actor,identity:Ed25519KeyIdentity.generate(),canister:"rrkah-fqaaa-aaaaa-aaaaq-cai",local:true});
  render(workspace(client));
  await screen.findByLabelText("Prepaid balance: 10,000,000,000 cycles");
  expect(screen.queryByText(/Your first key retrieval is included|Getting a key on a new browser/)).toBeNull();
  const create=screen.getByRole("button",{name:/^Create Vault$/}) as HTMLButtonElement;
  expect(create.disabled).toBe(false);
  clickAndDiscard(create);
  await screen.findByLabelText("Document title");
  await waitFor(()=>expect(create.disabled).toBe(true));
  expect(derive).toHaveBeenCalledTimes(1);
  clickAndDiscard(screen.getByRole("button",{name:"Vault 1"}));
  await waitFor(()=>expect((screen.getByText("Refresh balance") as HTMLButtonElement).disabled).toBe(false));
  expect(derive).toHaveBeenCalledTimes(1);
});

it("keeps destructive actions in settings and preserves an unsaved draft when returning", async () => {
  const x = await mounted();
  await x.open();
  fireEvent.change(screen.getByLabelText("Private note body"), { target: { value: "unsaved draft" } });
  const root = x.client.session.root;
  expect(screen.queryByText("Encrypted storage cleanup")).toBeNull();
  await openVaultSettings();
  const settings = screen.getByRole("region", { name: "Vault 1 settings" });
  const remove = within(settings).getByRole("button", { name: "Permanently delete this Vault" });
  expect(remove).toHaveProperty("disabled", true);
  fireEvent.change(within(settings).getByLabelText("Type Vault 1 to confirm"), { target: { value: "wrong vault" } });
  expect(remove).toHaveProperty("disabled", true);
  expect(x.headers).toHaveLength(2);
  clickAndDiscard(within(settings).getByRole("button", { name: "Back to Vault" }));
  expect(screen.getByLabelText("Private note body")).toHaveProperty("value", "unsaved draft");
  expect(x.client.session.root).toBe(root);
  expect(screen.queryByRole("region", { name: "Vault 1 settings" })).toBeNull();
  await openVaultSettings();
  const confirmation = screen.getByLabelText("Type Vault 1 to confirm");
  expect(confirmation).toHaveProperty("value", "");
  fireEvent.change(confirmation, { target: { value: "Vault 1" } });
  clickAndDiscard(screen.getByRole("button", { name: "Permanently delete this Vault" }));
  await waitFor(() => expect(x.headers).toHaveLength(1));
  expect(x.client.session.root).toBeUndefined();
});

it("asks before discarding a draft for a new document and cancels without changing it", async () => {
  const x = await mounted(); await x.open();
  fireEvent.change(screen.getByLabelText("Private note body"), {target:{value:"unsaved draft"}});
  fireEvent.click(screen.getByRole("button", {name:"New document"}));
  const dialog = await screen.findByRole("dialog", {name:"Discard unsaved changes?"});
  fireEvent.click(within(dialog).getByRole("button", {name:"Keep editing"}));
  expect(screen.getByLabelText("Private note body")).toHaveProperty("value", "unsaved draft");
  fireEvent.click(screen.getByRole("button", {name:"New document"}));  fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", {name:"Discard changes"}));
  expect(screen.getByLabelText("Private note body")).toHaveProperty("value", "");
});
it("never waits for draft confirmation on an automatic lock", async () => {
  const x = await mounted(); await x.open();
  fireEvent.change(screen.getByLabelText("Private note body"), {target:{value:"private draft"}});
  fireEvent.click(screen.getByRole("button", {name:"New document"}));
  await screen.findByRole("dialog");
  act(()=>x.client.session.lock());
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByLabelText("Private note body")).toBeNull();
});
it("does not retain a document deletion target after returning to edit another draft",async()=>{
 const x=await mounted();await x.open();await save("A","saved A");
 const dialog=await requestDocumentDeletion("A",true);
 fireEvent.click(within(dialog).getByRole("button",{name:"Cancel"}));
 fireEvent.click(screen.getByRole("button",{name:"New document"}));
 fireEvent.change(screen.getByLabelText("Private note body"),{target:{value:"new private draft"}});
 fireEvent.click(screen.getByRole("button",{name:"Account settings"}));
 expect(screen.queryByLabelText("Type delete to confirm")).toBeNull();
 expect(screen.queryByRole("button",{name:"Permanently delete document and history"})).toBeNull();
 fireEvent.click(screen.getByRole("button",{name:"Back to Vault"}));
 expect(screen.getByLabelText("Private note body")).toHaveProperty("value","new private draft");
});
it("does not transfer a pending copy status to another credential with the same password",async()=>{
 const x=await mounted();await x.open();
 for(const title of ["Credential A","Credential B"]){
  fireEvent.change(screen.getByLabelText("Document type"),{target:{value:"credential"}});
  fireEvent.change(screen.getByLabelText("Document title"),{target:{value:title}});
  fireEvent.change(screen.getByLabelText("Password"),{target:{value:"same password"}});
  fireEvent.click(screen.getByText("Save document"));await screen.findByRole("button",{name:title});
  await waitFor(()=>expect(screen.getByText("Refresh Vaults")).toHaveProperty("disabled",false));
  fireEvent.click(screen.getByRole("button",{name:"New document"}));
 }
 fireEvent.click(screen.getByRole("button",{name:"Credential A"}));
 await waitFor(()=>expect(screen.getByLabelText("Password")).toHaveProperty("value","same password"));
 await waitFor(()=>expect(screen.getByText("Refresh Vaults")).toHaveProperty("disabled",false));
 let finish!:()=>void;Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:()=>new Promise<void>(resolve=>{finish=resolve;})}});
 fireEvent.click(screen.getByRole("button",{name:"Copy password"}));
 fireEvent.click(screen.getByRole("button",{name:"Credential B"}));
 await waitFor(()=>expect(screen.getByLabelText("Document title")).toHaveProperty("value","Credential B"));
 await act(async()=>finish());
 expect(screen.queryByRole("button",{name:"Copied"})).toBeNull();
 expect(screen.getByRole("button",{name:"Copy password"})).toBeTruthy();
});
it("wipes the document deletion title synchronously before a lock commit",async()=>{
 const x=await mounted();await x.open();await save("Sensitive title","body");
 await requestDocumentDeletion("Sensitive title",true);
 const text=await screen.findByText(/This permanently deletes Sensitive title/);
 act(()=>{x.client.session.lock();expect(text.textContent).not.toContain("Sensitive title");});
});
it("invalidates a retained discard action synchronously when the session locks",async()=>{
 const x=await mounted();await x.open();
 const open=vi.spyOn(x.client,"open");
 fireEvent.change(screen.getByLabelText("Private note body"),{target:{value:"private draft"}});
 fireEvent.click(screen.getByRole("button",{name:"Vault 2"}));
 const discard=within(await screen.findByRole("dialog")).getByRole("button",{name:"Discard changes"});
 act(()=>{x.client.session.lock();fireEvent.click(discard);});
 expect(open).not.toHaveBeenCalled();
 expect(x.client.session.root).toBeUndefined();
});
it("clears a purged document even when viewing settings during the request",async()=>{
 const x=await mounted();await x.open();await save("A","saved A");
 const original=x.client.purgeObject.bind(x.client);let finish!:()=>void;
 vi.spyOn(x.client,"purgeObject").mockImplementation(async revision=>{await new Promise<void>(resolve=>{finish=resolve;});return original(revision);});
 await confirmDocumentDeletion("A",true);
 await waitFor(()=>expect(finish).toBeTypeOf("function"));
 fireEvent.click(screen.getByRole("button",{name:"Account settings"}));
 await act(async()=>finish());
 fireEvent.click(screen.getByRole("button",{name:"Back to Vault"}));
 await waitFor(()=>expect(screen.getByLabelText("Document title")).toHaveProperty("value",""));
});
it("keeps browser keys and the draft when key removal is cancelled",async()=>{
 const x=await mounted();await x.open();const forget=vi.spyOn(x.client,"forgetDeviceKeys");
 fireEvent.change(screen.getByLabelText("Private note body"),{target:{value:"private draft"}});
 fireEvent.click(screen.getByRole("button",{name:"Account settings"}));
 fireEvent.click(screen.getByRole("button",{name:"Delete saved keys from this browser"}));
 fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button",{name:"Keep editing"}));
 expect(forget).not.toHaveBeenCalled();expect(x.client.session.root).toBeTruthy();
 fireEvent.click(screen.getByRole("button",{name:"Back to Vault"}));
 expect(screen.getByLabelText("Private note body")).toHaveProperty("value","private draft");
});
it("lists titles without body reads and searches note bodies only on explicit request", async () => {
  const x = await mounted();
  await x.open();
  await save();
  const reads = vi.spyOn(x.actor, "get_chunk");
  fireEvent.click(screen.getByRole("button", {name:"Refresh documents"}));
  await waitFor(() =>
    expect(
      (screen.getByRole("button", {name:"Refresh documents"}) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  expect(reads).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Search this Vault locally"), {
    target: { value: "private words" },
  });
  expect(screen.queryByRole("button", { name: "Secret note" })).toBeNull();
  expect(reads).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Search note contents"));
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
    fireEvent.click(screen.getByText("Search note contents"));
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
it("confirms saved and keeps a clean editable document before a delayed refresh, then reports refresh failure as saved", async () => {
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
  ).toBe("Saved first");
  expect(
    (screen.getByLabelText("Private note body") as HTMLTextAreaElement).value,
  ).toBe("confirmed body");
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
  fireEvent.click(screen.getByText("Search note contents"));
  await screen.findByText("Note body search complete.");
  expect(screen.getByRole("button", { name: "Secret note" })).toBeTruthy();
  const list = vi.spyOn(x.actor, "list_objects");
  const before = list.mock.calls.length;
  fireEvent.click(screen.getByRole("button", {name:"Refresh documents"}));
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
  "private auto-lock clears private state without closing authenticated funding (unlocked=%s)",
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
    fireEvent.click(screen.getByRole("button", {name: "Account settings"}));
    fireEvent.click(
      screen.getByText("Account & storage").closest("summary")!,
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
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    fireEvent(document, new Event("visibilitychange"));
    act(() => {
      x.client.session.expire(x.client.session.lastActivity + 30 * 60 * 1000);
    });
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
