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
  // Fixture public keys are synthetic; only saved-key reuse checks them.
  validateRootHeader: () => {},
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
/** Accepts the destructive-action confirmation opened by the previous click. */
function confirmAction(label:string){
 fireEvent.click(screen.getByRole("button",{name:label}));
}
function clickAndDiscard(element:HTMLElement){
 fireEvent.click(element);
 const dialog=screen.queryByRole("dialog",{name:"Discard unsaved changes?"});
 if(dialog) fireEvent.click(within(dialog).getByRole("button",{name:"Discard changes"}));
}
async function mounted() {
  const identity = Ed25519KeyIdentity.generate();
  const sharedOwner = Ed25519KeyIdentity.generate();
  const network = fixtureNetwork(identity.getPrincipal(), sharedOwner.getPrincipal());
  const client = new VaultClient({
    actor: network.actor,
    identity,
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
  return { ...network, client, sharedOwner, view, open };
}
async function openVaultSettings(name = "Vault 1", manageMembers = false) {
  const actions = screen.getByRole("button", { name: `Actions for ${name}` });
  await waitFor(() => expect(actions).toHaveProperty("disabled", false));
  fireEvent.keyDown(actions, { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("menuitem", { name: manageMembers ? "Manage members" : "Vault settings" }));
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
  const guest = Ed25519KeyIdentity.generate().getPrincipal();
  await x.actor.set_vault_member(secondId, guest, { Viewer: null });
  await openVaultSettings("Vault 2", true);
  const settings = screen.getByRole("region", { name: "Vault 2 settings" });
  const member = (await within(settings).findByTitle(guest.toText())).closest("li")!;
  fireEvent.click(within(member).getByRole("button", { name: "Remove member" }));
  confirmAction("Remove");
  await within(settings).findByText("No additional members.");
  expect(await x.actor.list_vault_members(secondId)).toEqual({ Ok: [] });
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
it("removes a member from another Vault while preserving an interrupted save", async () => {
  const x = await mounted();
  await x.open();
  const target = x.headers[1].id;
  const guest = Ed25519KeyIdentity.generate().getPrincipal();
  await x.actor.set_vault_member(target, guest, { Viewer: null });
  const root = x.client.session.root;
  const ticket = x.client.session.capture();
  x.lose("SaveInline");
  fireEvent.change(screen.getByLabelText("Document title"), { target: { value: "Interrupted note" } });
  fireEvent.change(screen.getByLabelText("Private note body"), { target: { value: "retained save" } });
  fireEvent.click(screen.getByRole("button", { name: "Save document" }));
  await screen.findByText("Resume save");
  expect(x.client.hasPendingSave).toBe(true);

  await openVaultSettings("Vault 2", true);
  const row = (await screen.findByTitle(guest.toText())).closest("li")!;
  fireEvent.click(within(row).getByRole("button", { name: "Remove member" }));
  confirmAction("Remove");
  await screen.findByText("No additional members.");
  expect(await x.actor.list_vault_members(target)).toEqual({ Ok: [] });
  expect(x.client.session.root).toBe(root);
  expect(x.client.session.capture()).toBe(ticket);
  expect(x.client.hasPendingSave).toBe(true);

  fireEvent.click(screen.getByRole("button", { name: "Back to Vault" }));
  const resume = screen.getByRole("button", { name: "Resume save" });
  await waitFor(() => expect(resume).toHaveProperty("disabled", false));
  fireEvent.click(resume);
  await screen.findByText("Saved.");
  await waitFor(() => expect(x.client.hasPendingSave).toBe(false));
  const saves = x.calls.filter(({ action }) => "SaveInline" in action);
  expect(saves).toHaveLength(2);
  expect(saves[0]).toEqual(saves[1]);
});
async function save(title = "Secret note", body = "private words") {
  fireEvent.change(screen.getByLabelText("Document title"), {
    target: { value: title },
  });
  fireEvent.change(screen.getByLabelText("Private note body"), {
    target: { value: body },
  });
  clickAndDiscard(screen.getByRole("button", { name: "Save document" }));
  await screen.findByRole("button", { name: title });
  await waitFor(() =>
    expect(
      (screen.getByText("Refresh balance") as HTMLButtonElement).disabled,
    ).toBe(false),
  );
}
async function changeDocumentName(title: string, newName: string) {
  const trigger = screen.getByRole("button", { name: `Actions for ${title}` });
  await waitFor(() => expect(trigger).toHaveProperty("disabled", false));
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Change name" }));
  const dialog = await screen.findByRole("dialog", { name: "Change document name" });
  const input = within(dialog).getByLabelText("Document name");
  const saveName = within(dialog).getByRole("button", { name: "Save name" });
  expect(document.activeElement === input).toBe(true);
  expect(input).toHaveProperty("value", title);
  expect(saveName).toHaveProperty("disabled", true);
  fireEvent.change(input, { target: { value: newName } });
  fireEvent.click(saveName);
}
it("changes a saved note's name from its menu without switching the open draft", async () => {
  const x = await mounted();
  await x.open();
  await save("Original", "saved body");
  const original = x.revisions[0];
  fireEvent.click(screen.getByRole("button", { name: "New document" }));
  fireEvent.change(screen.getByLabelText("Document title"), { target: { value: "Draft" } });
  fireEvent.change(screen.getByLabelText("Private note body"), { target: { value: "draft body" } });
  await changeDocumentName("Original", "Renamed");
  await screen.findByRole("button", { name: "Renamed" });
  expect(screen.getByLabelText("Document title")).toHaveProperty("value", "Draft");
  expect(screen.getByLabelText("Private note body")).toHaveProperty("value", "draft body");
  expect(screen.queryByRole("dialog", { name: "Discard unsaved changes?" })).toBeNull();
  const revision = x.revisions.at(-1)!;
  expect(revision.object).toEqual(original.object);
  expect(revision.revision).toBe(2n);
  const doc = await x.client.read(revision);
  expect(doc.metadata.title).toBe("Renamed");
  expect(new TextDecoder().decode(doc.plaintext)).toBe("saved body");
  doc.plaintext.fill(0);
});
it("changes an attachment's name without asking for the original file again", async () => {
  const x = await mounted();
  await x.open();
  largeAttachment("Original attachment");
  fireEvent.click(screen.getByRole("button", { name: "Save document" }));
  await screen.findByRole("button", { name: "Original attachment" });
  await changeDocumentName("Original attachment", "Renamed attachment");
  await screen.findByRole("button", { name: "Renamed attachment" });
  const doc = await x.client.read(x.revisions.at(-1)!);
  expect(doc.metadata).toEqual({
    kind: "attachment",
    title: "Renamed attachment",
    filename: "large.bin",
    mime: "application/octet-stream",
  });
  expect(doc.plaintext).toEqual(new Uint8Array(262145).fill(7));
  doc.plaintext.fill(0);
});
it("updates the label of downloaded credentials while preserving other fields", async () => {
  const x = await mounted();
  await x.open();
  const original = { label: "Login", username: "alice", password: "secret", URL: "https://example.test", notes: "memo", custom: { enabled: true } };
  await x.client.save({ kind: "credential", title: original.label }, new TextEncoder().encode(JSON.stringify(original)));
  fireEvent.click(screen.getByRole("button", { name: "Refresh Vaults" }));
  const card = await screen.findByRole("button", { name: original.label });
  await waitFor(() => expect(card).toHaveProperty("disabled", false));
  fireEvent.click(card);
  await waitFor(() => expect(screen.getByLabelText("Document title")).toHaveProperty("value", original.label));
  await changeDocumentName(original.label, "Renamed login");
  await screen.findByRole("button", { name: "Renamed login" });
  const download = vi.spyOn(x.client.session, "download").mockImplementation((plaintext) => {
    expect(JSON.parse(new TextDecoder().decode(plaintext))).toEqual({ ...original, label: "Renamed login" });
  });
  const button = screen.getByRole("button", { name: "Download document" });
  await waitFor(() => expect(button).toHaveProperty("disabled", false));
  fireEvent.click(button);
  await waitFor(() => expect(download).toHaveBeenCalledOnce());
  await waitFor(() => expect(button).toHaveProperty("disabled", false));
  expect(screen.queryByRole("alert")).toBeNull();
});
it("adds another login to an existing credential and reloads both encrypted logins", async () => {
  const x = await mounted();
  await x.open();
  await x.client.save(
    { kind: "credential", title: "Logins" },
    new TextEncoder().encode(JSON.stringify({ username: "alice", password: "first", URL: "https://first.test", notes: "memo" })),
  );
  fireEvent.click(screen.getByRole("button", { name: "Refresh Vaults" }));
  const card = await screen.findByRole("button", { name: "Logins" });
  await waitFor(() => expect(card).toHaveProperty("disabled", false));
  fireEvent.click(card);
  await waitFor(() => expect(screen.getByLabelText("Username")).toHaveProperty("value", "alice"));

  fireEvent.click(screen.getByRole("button", { name: "Add login" }));
  const second = within(screen.getByRole("group", { name: "Login 2" }));
  expect(document.activeElement).toBe(second.getByLabelText("Username"));
  fireEvent.change(second.getByLabelText("Username"), { target: { value: "bob" } });
  fireEvent.change(second.getByLabelText("Password"), { target: { value: "second" } });
  fireEvent.change(second.getByLabelText("URL (stored as text)"), { target: { value: "https://second.test" } });
  fireEvent.click(second.getByRole("button", { name: "Show password" }));
  expect(second.getByLabelText("Password")).toHaveProperty("type", "text");
  expect(within(screen.getByRole("group", { name: "Login 1" })).getByLabelText("Password")).toHaveProperty("type", "password");
  fireEvent.click(screen.getByRole("button", { name: "Save document" }));
  await screen.findByText("Saved.");
  fireEvent.click(screen.getByRole("button", { name: "New document" }));
  fireEvent.click(screen.getByRole("button", { name: "Logins" }));
  await waitFor(() => expect(screen.getAllByLabelText("Password").map(input => (input as HTMLInputElement).value)).toEqual(["first", "second"]));
  expect(screen.getAllByLabelText("URL (stored as text)").map(input => (input as HTMLInputElement).value)).toEqual(["https://first.test", "https://second.test"]);
  expect(screen.getByLabelText("Credential notes")).toHaveProperty("value", "memo");
  fireEvent.click(within(screen.getByRole("group", { name: "Login 1" })).getByRole("button", { name: "Remove login" }));
  expect(screen.getByLabelText("Username")).toHaveProperty("value", "bob");
  expect(screen.getByLabelText("Password")).toHaveProperty("type", "password");
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add login" }));
});
it.each(["Resume save", "Cancel save"])("reconciles an interrupted change name via %s without discarding edits", async (action) => {
  const x = await mounted();
  await x.open();
  await save("Original", "saved body");
  fireEvent.change(screen.getByLabelText("Private note body"), { target: { value: "unsaved edit" } });
  x.lose("SaveInline");
  await changeDocumentName("Original", "Renamed");
  const reconcile = await screen.findByRole("button", { name: action });
  await waitFor(() => expect(reconcile).toHaveProperty("disabled", false));
  const history = vi.spyOn(x.actor, "list_history").mockRejectedValueOnce(Error("network"));
  fireEvent.click(reconcile);
  const renamed = await screen.findByRole("button", { name: "Renamed" });
  expect(history).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Document title")).toHaveProperty("value", "Renamed");
  expect(screen.getByLabelText("Private note body")).toHaveProperty("value", "unsaved edit");
  const read = vi.spyOn(x.client, "read");
  fireEvent.click(renamed);
  expect(read).not.toHaveBeenCalled();
  const saveAgain = screen.getByRole("button", { name: "Save document" });
  await waitFor(() => expect(saveAgain).toHaveProperty("disabled", false));
  fireEvent.click(saveAgain);
  await waitFor(() => {
    expect(screen.queryByRole("alert")?.textContent).toBeUndefined();
    expect(x.revisions.at(-1)!.revision).toBe(3n);
  });
});
it("retries a committed attachment rename when its revision cannot be read during cancellation", async () => {
  const x = await mounted();
  await x.open();
  largeAttachment("Original attachment");
  fireEvent.click(screen.getByRole("button", { name: "Save document" }));
  await screen.findByRole("button", { name: "Original attachment" });
  x.lose("CommitRevision");
  await changeDocumentName("Original attachment", "Renamed attachment");
  const cancel = await screen.findByRole("button", { name: "Cancel save" });
  await waitFor(() => expect(cancel).toHaveProperty("disabled", false));
  const { vault, object, revision, sequence } = x.revisions.at(-1)!;
  vi.spyOn(x.actor, "get_upload_status").mockResolvedValue({ Ok: { Committed: { vault, object, revision, sequence } } });
  const readManifest = vi.spyOn(x.actor, "get_manifest").mockRejectedValueOnce(Error("network"));
  fireEvent.click(cancel);
  await waitFor(() => expect(readManifest).toHaveBeenCalledOnce());
  await waitFor(() => expect(cancel).toHaveProperty("disabled", false));
  expect(x.client.hasPendingSave).toBe(true);
  expect(screen.getByLabelText("Document title")).toHaveProperty("value", "Original attachment");
  fireEvent.click(cancel);
  await screen.findByRole("button", { name: "Renamed attachment" });
  expect(screen.getByLabelText("Document title")).toHaveProperty("value", "Renamed attachment");
  expect(x.client.hasPendingSave).toBe(false);
  expect(x.revisions).toHaveLength(2);
});
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
  clickAndDiscard(screen.getByRole("button", { name: "New document" }));
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
it("opens with II, saves and reads encrypted notes, retains drafts and root through refresh", async () => {
  const x = await mounted();
  await x.open();
  expect(screen.queryByText(/Unlock|passkey/i)).toBeNull();
  await save();
  clickAndDiscard(screen.getByRole("button", { name: "New document" }));
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
});
it("shows saving and confirmed states on the save icon, then resets it on the next edit", async () => {
  const x = await mounted();
  await x.open();
  const persist = x.client.save.bind(x.client);
  let release!: () => void;
  const paused = new Promise<void>((resolve) => { release = resolve; });
  vi.spyOn(x.client, "save").mockImplementationOnce(async (...args) => {
    await paused;
    return persist(...args);
  });
  const body = screen.getByLabelText("Private note body");
  const button = screen.getByRole("button", { name: "Save document" });
  expect(button.textContent).toBe("");
  fireEvent.change(body, { target: { value: "draft" } });
  fireEvent.click(button);
  expect(button.getAttribute("aria-busy")).toBe("true");
  expect(button).toHaveProperty("disabled", true);
  release();
  await screen.findByText("Saved.");
  expect(button.getAttribute("title")).toBe("Document saved");
  expect(button.getAttribute("aria-busy")).toBe("false");
  fireEvent.change(body, { target: { value: "another edit" } });
  expect(button.getAttribute("title")).toBe("Save document");
  expect(button).toHaveProperty("disabled", false);
});
it("keeps the saved note in the editor and saves further edits as revisions of the same document", async () => {
  const x = await mounted();
  await x.open();
  const editor = screen.getByLabelText("Private note body");
  await save("Working note", "first draft");
  expect(screen.getByLabelText("Document title")).toHaveProperty("value", "Working note");
  expect(screen.getByLabelText("Private note body")).toBe(editor);
  expect(editor).toHaveProperty("value", "first draft");
  expect(screen.getByRole("button", { name: "Save document" })).toHaveProperty("disabled", true);
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

it("keeps an open note's title edit without reading its displayed revision again", async () => {
  const x = await mounted();
  await x.open();
  fireEvent.change(screen.getByLabelText("Private note body"), { target: { value: "private words" } });
  fireEvent.click(screen.getByRole("button", { name: "Save document" }));
  const item = await screen.findByRole("button", { name: "Untitled" });
  await waitFor(() => expect(item).toHaveProperty("disabled", false));
  const object = x.revisions[0].object;
  const read = vi.spyOn(x.client, "read");

  fireEvent.click(item);
  expect(read).not.toHaveBeenCalled();
  const title = screen.getByLabelText("Document title");
  fireEvent.change(title, { target: { value: "Renamed note" } });
  fireEvent.click(item);
  expect(screen.queryByRole("dialog", { name: "Discard unsaved changes?" })).toBeNull();
  expect(title).toHaveProperty("value", "Renamed note");
  expect(read).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Save document" }));
  await screen.findByRole("button", { name: "Renamed note" });
  expect(x.revisions.at(-1)!.object).toEqual(object);
  expect(x.revisions.at(-1)!.revision).toBe(2n);
  const doc = await x.client.read(x.revisions.at(-1)!);
  expect(doc.metadata.title).toBe("Renamed note");
  expect(new TextDecoder().decode(doc.plaintext)).toBe("private words");
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
  fireEvent.click(screen.getByRole("button", { name: "Save document" }));
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
  const listHistory = vi.spyOn(x.actor, "list_history");
  clickAndDiscard(screen.getByRole("button", { name: "Show version history" }));
  const view = await screen.findByRole("button", { name: "View revision 1" });
  expect(screen.queryByText("Download revision 1")).toBeNull();
  clickAndDiscard(view);
  await waitFor(() => expect(screen.getByLabelText("Private note body")).toHaveProperty("value", "original body"));
  expect(screen.getByLabelText("Document title")).toHaveProperty("value", "Original title");
  expect(screen.getByLabelText("Document title")).toHaveProperty("disabled", true);
  expect(screen.getByRole("button", { name: "Save document" })).toHaveProperty("disabled", true);
  const downloads: { body: string; filename: string }[] = [];
  vi.spyOn(x.client.session, "download").mockImplementation((data, filename) => {
    downloads.push({ body: new TextDecoder().decode(data), filename });
  });
  await waitFor(() => expect(screen.getByRole("button", { name: "Download document" })).toHaveProperty("disabled", false));
  clickAndDiscard(screen.getByRole("button", { name: "Download document" }));
  await waitFor(() => expect(downloads).toHaveLength(1));
  expect(downloads[0].body).toBe("original body");
  expect(downloads[0].filename).toContain("revision-1");
  clickAndDiscard(screen.getByRole("button", { name: "Return to latest version" }));
  await waitFor(() => expect(screen.getByLabelText("Private note body")).toHaveProperty("value", "latest body"));
  expect(screen.getByLabelText("Document title")).toHaveProperty("disabled", false);
  const hideHistory = screen.getByRole("button", { name: "Hide version history" });
  clickAndDiscard(hideHistory);
  expect(screen.queryByRole("heading", { name: "Version history" })).toBeNull();
  const showHistory = screen.getByRole("button", { name: "Show version history" });
  expect(showHistory).toBe(hideHistory);
  expect(showHistory.getAttribute("aria-expanded")).toBe("false");
  clickAndDiscard(showHistory);
  await screen.findByRole("button", { name: "View revision 1" });
  expect(listHistory).toHaveBeenCalledOnce();
  clickAndDiscard(screen.getByRole("button", { name: "Download document" }));
  await waitFor(() => expect(downloads).toHaveLength(2));
  expect(downloads[1].body).toBe("latest body");
  expect(downloads[1].filename).toContain("revision-2");
});
it("retains history after ordinary deletion and purges the document and history", async () => {
  const x = await mounted();
  await x.open();
  await save();
  clickAndDiscard(screen.getByRole("button", { name: "Secret note" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Show version history" })).toHaveProperty("disabled", false));
  clickAndDiscard(screen.getByRole("button", { name: "Show version history" }));
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
      (screen.getByRole("button", { name: "Show version history" }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  clickAndDiscard(screen.getByRole("button", { name: "Show version history" }));
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
    fireEvent.click(screen.getByRole("button", { name: "New document" }));
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
  clickAndDiscard(screen.getByRole("button", { name: "Save document" }));
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
  clickAndDiscard(screen.getByRole("button", { name: "New document" }));
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
  clickAndDiscard(screen.getByRole("button", { name: "Save document" }));
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
  expect(within(settings).queryByText("Shared capacity")).toBeNull();
  expect(within(settings).getByRole("button", { name: "Review payment" })).toBeTruthy();
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
  clickAndDiscard(screen.getByRole("button", { name: "Save document" }));
  await screen.findByText(/Another update changed/);
  expect(
    (screen.getByLabelText("Private note body") as HTMLTextAreaElement).value,
  ).toBe("conflicting draft");
  expect(x.client.hasPendingSave).toBe(false);
  fireEvent.click(screen.getByRole("button", {name:"Refresh Vaults"}));
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
it("collapses and reopens desktop Vault navigation without disturbing a draft", async () => {
  const x = await mounted();
  await x.open();
  fireEvent.change(screen.getByLabelText("Document title"), {
    target: { value: "private draft" },
  });
  const root = x.client.session.root;
  const toggle = screen.getByRole("button", {
    name: "Toggle Vault navigation",
  });
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("button", { name: "Vault 2" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Create Vault" })).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(x.client.session.root).toBe(root);
  expect(screen.getByDisplayValue("private draft")).toBeTruthy();
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(x.client.session.root).toBe(root);
  expect(screen.getByDisplayValue("private draft")).toBeTruthy();
  clickAndDiscard(screen.getByRole("button", { name: "Vault 2" }));
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(screen.queryByDisplayValue("private draft")).toBeNull();
  await waitFor(() =>
    expect(Array.from(x.client.header?.id ?? [])).toEqual(
      Array.from(x.headers[1].id),
    ),
  );
  await screen.findByLabelText("Document title");
});
it("keeps the current draft and skips canister reads when reselecting an open Vault", async () => {
  const x = await mounted();
  await x.open();
  const header = vi.spyOn(x.actor, "get_vault_header");
  const records = vi.spyOn(x.actor, "list_objects");
  fireEvent.change(screen.getByLabelText("Document title"), { target: { value: "Unsaved draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Vault 1" }));
  expect(screen.queryByRole("dialog", { name: "Discard unsaved changes?" })).toBeNull();
  expect(screen.getByLabelText("Document title")).toHaveProperty("value", "Unsaved draft");
  expect(header).not.toHaveBeenCalled();
  expect(records).not.toHaveBeenCalled();
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
  clickAndDiscard(screen.getByRole("button", { name: "Save document" }));
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
  clickAndDiscard(screen.getByRole("button", { name: "New document" }));
  await save("Remove", "old body");
  clickAndDiscard(screen.getByRole("button", { name: "Remove" }));
  await waitFor(() =>
    expect(
      (screen.getByLabelText("Private note body") as HTMLTextAreaElement).value,
    ).toBe("old body"),
  );
  await save("Remove", "new body");
  clickAndDiscard(screen.getByRole("button", { name: "Remove" }));
  await screen.findByRole("button", { name: "Show version history" });
  x.setBalance(0n);
  clickAndDiscard(screen.getByText("Refresh balance"));
  await screen.findByLabelText("Prepaid balance: 0 cycles");
  expect(screen.getByRole("button", { name: "Save document" })).toHaveProperty("disabled", true);
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
    confirmAction("Free up storage");
    await waitFor(() => expect(x.calls).toHaveLength(1));
    await waitFor(() =>
      expect(
        (screen.getByText("Free up unused storage") as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    clickAndDiscard(screen.getByText("Free up unused storage"));
    confirmAction("Free up storage");
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
    confirmAction("Free up storage");
    await waitFor(() => expect(x.calls).toHaveLength(3));
    expect(x.calls[2].operation).not.toEqual(x.calls[0].operation);
  },
);

it("reconciles a lost cancellation reply while retaining the pending save", async () => {
  const x = await mounted();
  await x.open();
  x.lose("PutChunk");
  largeAttachment("Cancelled attachment");
  fireEvent.click(screen.getByRole("button", { name: "Save document" }));
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
  expect((screen.getByRole("button", { name: "Save document" }) as HTMLButtonElement).disabled).toBe(true);
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
  fireEvent.click(screen.getByRole("button", { name: "Save document" }));await screen.findByRole("button",{name:title});
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
 confirmAction("Delete keys");
 fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button",{name:"Keep editing"}));
 expect(forget).not.toHaveBeenCalled();expect(x.client.session.root).toBeTruthy();
 fireEvent.click(screen.getByRole("button",{name:"Back to Vault"}));
 expect(screen.getByLabelText("Private note body")).toHaveProperty("value","private draft");
});
it("refreshes Vaults and document titles together without reading bodies", async () => {
  const x = await mounted();
  await x.open();
  await save();
  const header = vi.spyOn(x.actor, "get_vault_header");
  const balance = vi.spyOn(x.actor, "account_balance");
  const keyCost = vi.spyOn(x.actor, "vault_key_cost");
  const reads = vi.spyOn(x.actor, "get_chunk");
  const vaults = vi.spyOn(x.actor, "list_accessible_vaults");
  const documents = vi.spyOn(x.actor, "list_objects");
  expect(screen.queryByRole("button", { name: "Refresh documents" })).toBeNull();
  fireEvent.click(screen.getByRole("button", {name:"Refresh Vaults"}));
  await waitFor(() =>
    expect(
      (screen.getByRole("button", {name:"Refresh Vaults"}) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  await waitFor(() => expect(balance).toHaveBeenCalledOnce());
  expect(header).toHaveBeenCalledOnce();
  expect(keyCost).not.toHaveBeenCalled();
  expect(vaults).toHaveBeenCalledOnce();
  expect(documents).toHaveBeenCalledOnce();
  expect(reads).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Secret note" })).toBeTruthy();
  expect(screen.queryByRole("searchbox")).toBeNull();
  expect(screen.queryByRole("heading", { name: "Private documents" })).toBeNull();
});
it("unlocks the workspace before the completed operation's balance refresh returns", async () => {
  const x = await mounted();
  await x.open();
  let finish!: (value: { Ok: bigint }) => void;
  vi.spyOn(x.actor, "account_balance").mockImplementationOnce(
    () => new Promise((resolve) => { finish = resolve; }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Refresh Vaults" }));
  await waitFor(() => expect(finish).toBeDefined());
  await waitFor(() => expect(screen.getByRole("button", { name: "Refresh Vaults" })).toHaveProperty("disabled", false));
  await act(async () => finish({ Ok: 50_000_000_000n }));
});

it("keeps newer paid availability when an earlier advisory reply arrives late", async () => {
  const x = await mounted();
  await x.open();
  let finish!: (value: Awaited<ReturnType<typeof x.actor.get_spending_status>>) => void;
  vi.spyOn(x.actor, "get_spending_status")
    .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
    .mockResolvedValueOnce({ Ok: { ServiceReserveLow: null } });
  fireEvent.click(screen.getByRole("button", { name: "Refresh Vaults" }));
  await waitFor(() => expect(finish).toBeDefined());
  const refresh = screen.getByText("Refresh balance");
  await waitFor(() => expect(refresh).toHaveProperty("disabled", false));
  fireEvent.click(refresh);
  await screen.findByText(/service cycles reserve is low/i);
  await act(async () => finish({ Ok: { Available: null } }));
  expect(screen.getByText(/service cycles reserve is low/i)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Create Vault" })).toHaveProperty("disabled", true);
});

it("confirms an interrupted committed save after credit runs out", async () => {
  const x = await mounted();
  await x.open();
  const mutate = x.actor.mutate;
  vi.spyOn(x.actor, "mutate").mockImplementationOnce(async (request) => {
    x.lose("SaveInline");
    x.setBalance(0n);
    return mutate(request);
  });
  fireEvent.change(screen.getByLabelText("Document title"), { target: { value: "Committed once" } });
  fireEvent.change(screen.getByLabelText("Private note body"), { target: { value: "Recover my save" } });
  fireEvent.click(screen.getByRole("button", { name: "Save document" }));
  await screen.findByLabelText("Prepaid balance: 0 cycles");
  const resume = screen.getByRole("button", { name: "Resume save" });
  await waitFor(() => expect(resume).toHaveProperty("disabled", false));
  fireEvent.click(resume);
  await screen.findByText("Saved.");
  expect(x.revisions).toHaveLength(1);
  expect(x.calls[0]).toEqual(x.calls[1]);
  expect(screen.getByRole("button", { name: "Save document" })).toHaveProperty("disabled", true);
});

it("recovers a delivered Vault creation receipt without enough credit to derive a key", async () => {
  const x = await mounted();
  const create = x.actor.create_vault;
  vi.spyOn(x.actor, "create_vault").mockImplementationOnce(async (request) => {
    x.setBalance(0n);
    x.loseCreate();
    return create(request);
  });
  const derive = vi.spyOn(x.actor, "derive_vault_key");
  clickAndDiscard(screen.getByText("Create Vault"));
  await screen.findByLabelText("Prepaid balance: 0 cycles");
  const retry = screen.getByRole("button", { name: "Retry Vault creation" });
  await waitFor(() => expect(retry).toHaveProperty("disabled", false));
  fireEvent.click(retry);
  await screen.findByRole("button", { name: "Retry opening Vault" });
  expect(x.creation).toHaveLength(2);
  expect(x.creation[0]).toEqual(x.creation[1]);
  expect(x.headers).toHaveLength(3);
  expect(derive).not.toHaveBeenCalled();
});

it.each(["reply", "rejection"] as const)(
  "recovers the same creation at zero credit after locking before its %s",
  async (outcome) => {
    const x = await mounted();
    const create = x.actor.create_vault;
    let finish!: () => void;
    vi.spyOn(x.actor, "create_vault").mockImplementationOnce(async (request) => {
      const result = await create(request);
      await new Promise<void>((resolve) => { finish = resolve; });
      if (outcome === "rejection") throw Error("lost creation reply");
      return result;
    });
    fireEvent.click(screen.getByText("Create Vault"));
    await waitFor(() => expect(finish).toBeDefined());
    x.setBalance(0n);
    await act(async () => x.client.session.lock());
    await screen.findByLabelText("Prepaid balance: 0 cycles");
    await act(async () => finish());
    expect(x.client.header).toBeUndefined();
    expect(screen.queryByRole("alert")).toBeNull();

    const retry = screen.getByRole("button", { name: "Retry Vault creation" });
    expect(retry).toHaveProperty("disabled", false);
    fireEvent.click(retry);
    await screen.findByRole("button", { name: "Retry opening Vault" });
    expect(x.creation).toHaveLength(2);
    expect(x.creation[0]).toEqual(x.creation[1]);
    expect(x.headers).toHaveLength(3);
  },
);

it("keeps exact creation recovery available after a refusal follows a lost reply", async () => {
  const x = await mounted();
  const create = vi.spyOn(x.actor, "create_vault")
    .mockImplementationOnce(async () => {
      x.setBalance(0n);
      throw Error("lost creation reply");
    })
    .mockResolvedValueOnce({ Err: { QuotaExceeded: null } });
  fireEvent.click(screen.getByText("Create Vault"));
  await screen.findByLabelText("Prepaid balance: 0 cycles");
  const retry = screen.getByRole("button", { name: "Retry Vault creation" });
  expect(retry).toHaveProperty("disabled", false);
  fireEvent.click(retry);
  await screen.findByText(/storage, operation or cycles limit/);
  expect(retry).toHaveProperty("disabled", false);
  expect(within(screen.getByRole("region", { name: "Choose a Vault" })).queryByLabelText("KINIC amount")).toBeNull();

  x.setBalance(50_000_000_000n);
  fireEvent.click(screen.getByText("Refresh balance"));
  await screen.findByLabelText("Prepaid balance: 50,000,000,000 cycles");
  await waitFor(() => expect(retry).toHaveProperty("disabled", false));
  fireEvent.click(retry);
  await screen.findByLabelText("Document title");
  expect(create).toHaveBeenCalledTimes(3);
  expect(create.mock.calls[0][0]).toEqual(create.mock.calls[1][0]);
  expect(create.mock.calls[1][0]).toEqual(create.mock.calls[2][0]);
});

it("offers funding for a sponsored key when server admission is low despite the raw balance", async () => {
  const x = await mounted();
  x.setFirstKeyFree(true);
  x.setBalance(25_000_000n);
  vi.spyOn(x.actor, "get_spending_status").mockResolvedValue({
    Ok: { AccountCreditLow: null },
  });
  const derive = vi.spyOn(x.actor, "derive_vault_key");
  fireEvent.click(screen.getByRole("button", { name: "Vault 1" }));
  await screen.findByText(/Add prepaid balance here to retrieve/);

  const panel = screen.getByRole("region", { name: "Open Vault" });
  expect(within(panel).getByRole("button", { name: "Retry opening Vault" })).toHaveProperty("disabled", true);
  expect(within(panel).getByLabelText("KINIC amount")).toBeTruthy();
  expect(derive).not.toHaveBeenCalled();
});

it("retries every remaining deletion batch at zero credit from the workspace action", async () => {
  const x = await mounted();
  x.setBalance(0n);
  fireEvent.click(screen.getByText("Refresh balance"));
  await screen.findByLabelText("Prepaid balance: 0 cycles");
  await openVaultSettings("Vault 2");
  const mutate = vi.spyOn(x.actor, "mutate")
    .mockRejectedValueOnce(Error("Lost deletion reply"))
    .mockResolvedValueOnce({ Ok: { Progress: false } });
  const settings = screen.getByRole("region", { name: "Vault 2 settings" });
  fireEvent.change(within(settings).getByLabelText("Type Vault 2 to confirm"), { target: { value: "Vault 2" } });
  fireEvent.click(within(settings).getByText("Permanently delete this Vault"));
  const alert = await screen.findByRole("alert");
  fireEvent.click(within(alert).getByRole("button", { name: "Retry interrupted change" }));
  await waitFor(() => expect(x.headers).toHaveLength(1));
  expect(mutate.mock.calls[0][0]).toEqual(mutate.mock.calls[1][0]);
  expect(mutate.mock.calls[2][0].action).toEqual(mutate.mock.calls[1][0].action);
  expect(mutate.mock.calls[2][0].operation).not.toEqual(mutate.mock.calls[1][0].operation);
});

it("distinguishes a low service reserve from a need to add owner credit", async () => {
  const x = await mounted();
  vi.spyOn(x.actor, "get_spending_status").mockResolvedValue({
    Ok: { ServiceReserveLow: null },
  });
  fireEvent.click(screen.getByText("Refresh balance"));
  await screen.findByText(/service cycles reserve is low/i);
  expect(screen.getByText("Create Vault")).toHaveProperty("disabled", true);
  expect(screen.queryByRole("button", { name: "Review payment" })).toBeNull();
  expect(screen.getByText("Refresh Vaults")).toHaveProperty("disabled", false);
});

it("updates the document card from the save receipt without refetching the lists or key price", async () => {
  const x = await mounted();
  await x.open();
  const documents = vi.spyOn(x.actor, "list_objects");
  const roster = vi.spyOn(x.actor, "list_accessible_vaults");
  const uploads = vi.spyOn(x.actor, "list_pending_uploads");
  const header = vi.spyOn(x.actor, "get_vault_header");
  const balance = vi.spyOn(x.actor, "account_balance");
  const keyCost = vi.spyOn(x.actor, "vault_key_cost");
  await save("Saved first", "confirmed body");
  await waitFor(() => expect(balance).toHaveBeenCalledOnce());
  expect(documents).not.toHaveBeenCalled();
  expect(roster).not.toHaveBeenCalled();
  expect(uploads).not.toHaveBeenCalled();
  expect(header).not.toHaveBeenCalled();
  expect(keyCost).not.toHaveBeenCalled();
  expect(x.calls.filter(({ action }) => "SaveInline" in action)).toHaveLength(1);
  expect(screen.getByLabelText("Document title")).toHaveProperty("value", "Saved first");
  expect(screen.getByLabelText("Private note body")).toHaveProperty("value", "confirmed body");
  expect(screen.getByRole("button", { name: "Save document" })).toHaveProperty("disabled", true);
});

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

it("shows only live role capabilities for shared Vaults and closes on revocation", async () => {
  const x = await mounted();
  x.headers[1].name = ["Shared team Vault"];
  x.setRole(x.headers[1].id, { Editor: null });
  x.setBalance(0n);
  fireEvent.click(screen.getByText("Refresh Vaults"));
  fireEvent.click(await screen.findByRole("button", { name: "Shared team Vault · Editor" }));
  await screen.findByLabelText("Document title");
  expect(screen.queryByText("Add balance to create a Vault")).toBeNull();
  await save("Shared note");
  fireEvent.keyDown(screen.getByRole("button", { name: "Actions for Shared note" }), { key: "ArrowDown" });
  await screen.findByRole("menuitem", { name: "Delete document" });
  expect(
    screen.queryByRole("menuitem", { name: "Permanently delete document and history" }),
  ).toBeNull();
  expect(screen.queryByRole("button", { name: "Actions for Shared team Vault" })).toBeNull();
  fireEvent.keyDown(screen.getByRole("menuitem", { name: "Delete document" }), { key: "Escape" });
  x.setRole(x.headers[1].id, { Viewer: null });
  fireEvent(window, new Event("focus"));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Save document" })).toBeNull());
  expect(screen.queryByRole("button", { name: "New document" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Shared note" }));
  await screen.findByText("private words");
  expect(screen.queryByText("Delete document")).toBeNull();
  expect(screen.getByRole("button", { name: "Shared team Vault · Viewer" })).toBeTruthy();
  x.setRole(x.headers[1].id, null);
  fireEvent(window, new Event("focus"));
  await screen.findByText("Choose or create a Vault");
  expect(screen.queryByText("private words")).toBeNull();
  await waitFor(() => expect(screen.queryByRole("button", { name: /Shared team Vault/ })).toBeNull());
});

it.each(["open", "Refresh Vaults", "document page"])(
  "removes the exact denied shared Vault from the roster on %s",
  async (action) => {
    const x = await mounted();
    const header = x.headers[1];
    header.name = ["Shared team Vault"];
    x.setRole(header.id, { Editor: null });
    fireEvent.click(screen.getByText("Refresh Vaults"));
    const shared = await screen.findByRole("button", { name: "Shared team Vault · Editor" });
    await waitFor(() => expect(shared).toHaveProperty("disabled", false));
    if (action !== "open") {
      fireEvent.click(shared);
      await screen.findByLabelText("Document title");
    }
    const staleRoster = await x.actor.list_accessible_vaults(new Uint8Array());
    if (action === "Refresh Vaults")
      vi.spyOn(x.actor, "list_accessible_vaults").mockResolvedValueOnce(staleRoster);
    if (action === "document page")
      vi.spyOn(x.actor, "shared_list_objects").mockResolvedValueOnce({ Err: { Unauthorized: null } });
    else x.setRole(header.id, null);
    const control = action === "open" ? shared : screen.getByRole("button", { name: "Refresh Vaults" });
    await waitFor(() => expect(control).toHaveProperty("disabled", false));
    fireEvent.click(control);
    await waitFor(() => expect(screen.queryByRole("button", { name: /Shared team Vault/ })).toBeNull());
    expect(screen.getByRole("button", { name: "Vault 1" })).toBeTruthy();
    expect(x.client.session.root).toBeUndefined();
  },
);

it("ignores a late denial after opening a different Vault", async () => {
  const x = await mounted();
  x.setRole(x.headers[1].id, { Editor: null });
  fireEvent.click(screen.getByText("Refresh Vaults"));
  const shared = await screen.findByRole("button", { name: "Vault 2 · Editor" });
  await waitFor(() => expect(shared).toHaveProperty("disabled", false));
  fireEvent.click(shared);
  await screen.findByLabelText("Document title");
  const refresh = screen.getByRole("button", { name: "Refresh Vaults" });
  await waitFor(() => expect(refresh).toHaveProperty("disabled", false));
  let deny!: () => void;
  vi.spyOn(x.actor, "get_vault_access").mockImplementationOnce(() =>
    new Promise((resolve) => { deny = () => resolve({ Err: { Unauthorized: null } }); }),
  );
  fireEvent(window, new Event("focus"));
  await waitFor(() => expect(deny).toBeTypeOf("function"));
  await x.open();
  const root = x.client.session.root;
  const ticket = x.client.session.capture();
  await act(async () => deny());
  expect(x.client.session.root).toBe(root);
  expect(x.client.session.capture()).toBe(ticket);
  expect(screen.getByRole("button", { name: "Vault 2 · Editor" })).toBeTruthy();
});

it("keeps an authorized shared Vault available to retry when key retrieval is paused", async () => {
  const x = await mounted();
  const header = x.headers[1];
  header.name = ["Shared team Vault"];
  x.setRole(header.id, { Viewer: null });
  fireEvent.click(screen.getByText("Refresh Vaults"));
  const name = "Shared team Vault · Viewer";
  const shared = await screen.findByRole("button", { name });
  await waitFor(() => expect(shared).toHaveProperty("disabled", false));
  let pauseKey!: () => void;
  const derive = vi.spyOn(x.actor, "shared_derive_vault_key").mockImplementationOnce(() =>
    new Promise((resolve) => { pauseKey = () => resolve({ Err: { Unauthorized: null } }); }),
  );
  const roster = vi.spyOn(x.actor, "list_accessible_vaults");
  fireEvent.click(shared);
  await waitFor(() => expect(pauseKey).toBeTypeOf("function"));
  await act(async () => pauseKey());
  await screen.findByText("Choose or create a Vault");
  expect(x.client.session.root).toBeUndefined();
  const retry = screen.getByRole("button", { name });
  await waitFor(() => expect(retry).toHaveProperty("disabled", false));
  fireEvent.click(retry);
  await screen.findByText("No documents yet.");
  expect(derive).toHaveBeenCalledTimes(2);
  expect(roster).not.toHaveBeenCalled();
});

it("scopes shared open, document refresh and save to the grant when the member has prepaid balance", async () => {
  const x = await mounted();
  x.setRole(x.headers[1].id, { Editor: null });
  fireEvent.click(screen.getByText("Refresh Vaults"));
  const shared = await screen.findByRole("button", { name: "Vault 2 · Editor" });
  await waitFor(() => expect(shared).toHaveProperty("disabled", false));
  expect(await x.actor.account_balance()).toEqual({ Ok: 50_000_000_000n });
  const ownerUploads = vi.spyOn(x.actor, "list_pending_uploads");
  const accessList = vi.spyOn(x.actor, "list_accessible_vaults");
  const sharedReads = vi.spyOn(x.actor, "shared_list_objects");
  fireEvent.click(shared);
  const refresh = await screen.findByRole("button", { name: "Refresh Vaults" });
  await waitFor(() => expect(refresh).toHaveProperty("disabled", false));
  fireEvent.click(refresh);
  await waitFor(() => expect(refresh).toHaveProperty("disabled", false));
  await save("Shared funded note");
  await waitFor(() => expect(sharedReads).toHaveBeenCalledTimes(2));
  expect(ownerUploads).not.toHaveBeenCalled();
  expect(accessList).toHaveBeenCalledOnce();
});

it.each([
  [{ AccountCreditLow: null }, false],
  [{ ServiceReserveLow: null }, true],
  [{ Unconfigured: null }, true],
] as const)("applies shared Editor save admission for %j", async (status, disabled) => {
  const x = await mounted();
  x.setRole(x.headers[1].id, { Editor: null });
  fireEvent.click(screen.getByText("Refresh Vaults"));
  const shared = await screen.findByRole("button", { name: "Vault 2 · Editor" });
  await waitFor(() => expect(shared).toHaveProperty("disabled", false));
  fireEvent.click(shared);
  await screen.findByLabelText("Document title");
  await waitFor(() => expect(screen.getByText("Refresh balance")).toHaveProperty("disabled", false));

  fireEvent.change(screen.getByLabelText("Document title"), { target: { value: "Team note" } });
  fireEvent.change(screen.getByLabelText("Private note body"), { target: { value: "Editor draft" } });
  expect(screen.getByRole("button", { name: "Save document" })).toHaveProperty("disabled", false);
  x.setBalance(0n);
  vi.spyOn(x.actor, "get_spending_status").mockResolvedValue({ Ok: status });
  fireEvent.click(screen.getByText("Refresh balance"));
  await screen.findByLabelText("Prepaid balance: 0 cycles");

  await waitFor(() => expect(screen.getByRole("button", { name: "Save document" })).toHaveProperty("disabled", disabled));
  expect(screen.getByRole("button", { name: "Refresh Vaults" })).toHaveProperty("disabled", false);
});

it.each(["omitted", "changed in the list", "still listed", "outside the loaded page"])(
  "handles an exact access transport error when the open shared Vault is %s",
  async (state) => {
    const x = await mounted();
    const header = x.headers[1];
    x.setRole(header.id, { Editor: null });
    fireEvent.click(screen.getByText("Refresh Vaults"));
    const shared = await screen.findByRole("button", { name: "Vault 2 · Editor" });
    await waitFor(() => expect(shared).toHaveProperty("disabled", false));
    fireEvent.click(shared);
    const draft = await screen.findByLabelText("Private note body");
    const refresh = screen.getByRole("button", { name: "Refresh Vaults" });
    await waitFor(() => expect(refresh).toHaveProperty("disabled", false));
    fireEvent.change(draft, { target: { value: "sensitive draft" } });
    const root = x.client.session.root;
    if (state === "omitted") x.setRole(header.id, null);
    if (state === "changed in the list") header.nonce = new Uint8Array(32).fill(9);
    if (state === "outside the loaded page") {
      const added = Array.from({ length: 20 }, (_, index) => ({
        ...header,
        id: new Uint8Array(16).fill(index + 3),
      }));
      x.headers.splice(1, 0, ...added);
      for (const entry of added) x.setRole(entry.id, { Viewer: null });
    }
    const access = vi.spyOn(x.actor, "get_vault_access").mockRejectedValueOnce(Error("NetworkUnavailable"));
    fireEvent.click(refresh);
    await waitFor(() => expect(access).toHaveBeenCalledWith(new Uint8Array(header.id)));
    if (state === "still listed" || state === "outside the loaded page") {
      await screen.findByRole("alert");
      expect(x.client.session.root).toBe(root);
      expect(draft).toHaveProperty("value", "sensitive draft");
      if (state === "still listed") expect(screen.getByRole("button", { name: "Vault 2 · Editor" })).toBeTruthy();
    } else {
      await screen.findByText("Choose or create a Vault");
      expect(x.client.session.root).toBeUndefined();
      expect(draft).toHaveProperty("value", "");
    }
  },
);

it("shows owner credit guidance after shared key admission fails without offering caller funding", async () => {
  const x = await mounted();
  x.setRole(x.headers[1].id, { Viewer: null });
  x.setBalance(0n);
  const derive = vi.spyOn(x.actor, "shared_derive_vault_key").mockResolvedValue({ Err: { QuotaExceeded: null } });
  fireEvent.click(screen.getByText("Refresh Vaults"));
  fireEvent.click(await screen.findByRole("button", { name: "Vault 2 · Viewer" }));
  await screen.findByText(/Vault owner.*prepaid balance/i);
  expect(derive).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "Retry opening Vault" })).toHaveProperty("disabled", false);
  expect(screen.queryByText("Add balance to create a Vault")).toBeNull();
  expect(screen.queryByRole("button", { name: "Review payment" })).toBeNull();
});

it("requires a fresh explicit credential reveal when a Viewer opens an older revision", async () => {
  const x = await mounted();
  const header = x.headers[1];
  const writer = new VaultClient({ actor: x.actor, identity: x.sharedOwner, canister: x.client.canister, local: true });
  const metadata = { kind: "credential", title: "Shared credential" } as const;
  const credential = (password: string) => new TextEncoder().encode(JSON.stringify({ password }));
  await writer.open(header);
  const revision = await writer.save(metadata, credential("old private password"));
  await writer.save(metadata, credential("new private password"), { revision, metadata });
  writer.destroy();

  x.setRole(header.id, { Viewer: null });
  fireEvent.click(screen.getByText("Refresh Vaults"));
  fireEvent.click(await screen.findByRole("button", { name: "Vault 2 · Viewer" }));
  fireEvent.click(await screen.findByRole("button", { name: "Shared credential" }));
  const reveal = () => screen.findByRole("button", { name: "Show credential" });
  await reveal();
  expect(screen.queryByText("new private password")).toBeNull();
  fireEvent.click(await reveal());
  await screen.findByText("new private password");
  fireEvent.click(screen.getByRole("button", { name: "Show version history" }));
  fireEvent.click(await screen.findByRole("button", { name: "View revision 1" }));
  await reveal();
  expect(screen.queryByText("new private password")).toBeNull();
  expect(screen.queryByText("old private password")).toBeNull();
  expect(screen.queryByRole("button", { name: "Save document" })).toBeNull();
  fireEvent.click(await reveal());
  await screen.findByText("old private password");
});

it("lets only the owner add, update, and remove members by Vault principal", async () => {
  const x = await mounted();
  await x.open();
  await openVaultSettings(undefined, true);
  await screen.findByText("No additional members.");
  const guest = Ed25519KeyIdentity.generate().getPrincipal().toText();
  fireEvent.change(screen.getByLabelText("Member Vault principal"), {
    target: { value: guest },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add member" }));
  const member = await screen.findByTitle(guest);
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
  confirmAction("Remove");
  await waitFor(() => expect(screen.queryByTitle(guest)).toBeNull());
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
  expect(screen.queryByText("Vault 21 · Viewer")).toBeNull();
  fireEvent.click(screen.getByText("Load more Vaults"));
  fireEvent.click(await screen.findByText("Vault 21 · Viewer"));
  await waitFor(() => expect(x.client.session.root).toBeTruthy());
  await screen.findByText("No documents yet.");
  x.setRole(x.headers[20].id, null);
  fireEvent(window, new Event("focus"));
  await screen.findByText("Choose or create a Vault");
  expect(x.client.session.root).toBeUndefined();
});

it("lets a cold owner remove a member at zero credit after key service failure without another key request", async () => {
  const x = await mounted();
  const guest = Ed25519KeyIdentity.generate().getPrincipal();
  await x.actor.set_vault_member(x.headers[0].id, guest, { Viewer: null });
  x.failKey(true);
  const derive = vi.spyOn(x.actor, "derive_vault_key");
  fireEvent.click(screen.getByText("Vault 1"));
  await screen.findByText(/key service is unavailable/);
  expect(screen.queryByLabelText("Document title")).toBeNull();
  x.setBalance(0n);
  await openVaultSettings(undefined, true);
  const row = (await screen.findByTitle(guest.toText())).closest("li")!;
  fireEvent.click(within(row).getByRole("button", { name: "Remove member" }));
  confirmAction("Remove");
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
  await openVaultSettings("Vault 1", true);
  await waitFor(() => expect(release).toBeTypeOf("function"));
  act(() => x.client.session.lock());
  fireEvent.click(screen.getByRole("button", { name: "Back to Vault" }));
  await openVaultSettings("Vault 2", true);
  await screen.findByTitle(b.toText());
  await act(async () => release());
  expect(screen.queryByTitle(a.toText())).toBeNull();
  expect(screen.getByTitle(b.toText())).toBeTruthy();
  expect(derive).not.toHaveBeenCalled();
});

it("refuses member administration for a shared Vault while its key service is unavailable", async () => {
  const x = await mounted();
  x.setRole(x.headers[1].id, { Viewer: null });
  x.failKey(true);
  fireEvent.click(screen.getByText("Refresh Vaults"));
  fireEvent.click(await screen.findByText("Vault 2 · Viewer"));
  await screen.findByText(/key service is unavailable/);
  expect(
    screen.queryByRole("button", { name: "Actions for Vault 2" }),
  ).toBeNull();
  expect(screen.queryByText("Vault members")).toBeNull();
  const guest = Ed25519KeyIdentity.generate().getPrincipal();
  await expect(x.client.listMembers()).rejects.toThrow("Unauthorized");
  await expect(x.client.removeMember(guest)).rejects.toThrow("Unauthorized");
});

it("clears the previous private view when switching to a Vault whose owner header fails", async () => {
  const x = await mounted();
  await x.open();
  const input = screen.getByLabelText("Document title") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "unsaved private title" } });
  vi.spyOn(x.actor, "get_vault_header").mockRejectedValueOnce(
    Error("NetworkUnavailable"),
  );
  clickAndDiscard(screen.getByRole("button", { name: "Vault 2" }));
  await screen.findByText("Retry opening Vault");
  expect(input.value).toBe("");
  expect(screen.queryByLabelText("Document title")).toBeNull();
  expect(x.client.session.root).toBeUndefined();
  await openVaultSettings("Vault 2", true);
  expect(screen.getByText("Vault members")).toBeTruthy();
});


it.each([
  [15_000_000n, { Available: null }, true],
  [19_999_999n, { Available: null }, true],
  [20_000_000n, { Available: null }, false],
  [50_000_000n, { AccountCreditLow: null }, true],
] as const)("gates fresh owner saves on the latest balance %s and status %j", async (balance, status, disabled) => {
  const x = await mounted();
  await x.open();
  fireEvent.change(screen.getByLabelText("Document title"), { target: { value: "New note" } });
  fireEvent.change(screen.getByLabelText("Private note body"), { target: { value: "Keep draft" } });
  x.setBalance(balance);
  vi.spyOn(x.actor, "get_spending_status").mockResolvedValue({ Ok: status });
  const mutate = vi.spyOn(x.actor, "mutate");
  fireEvent.click(screen.getByText("Refresh balance"));
  await screen.findByLabelText(`Prepaid balance: ${balance.toLocaleString("en-US")} cycles`);
  await waitFor(() => expect(screen.getByText("Refresh balance")).toHaveProperty("disabled", false));
  const saveButton = screen.getByRole("button", { name: "Save document" });
  expect(saveButton).toHaveProperty("disabled", disabled);
  if (disabled) {
    fireEvent.click(saveButton);
    expect(mutate).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Private note body")).toHaveProperty("value", "Keep draft");
  }
});


it("pauses fresh owner saves while the post-operation balance is unresolved", async () => {
  const x = await mounted();
  await x.open();
  fireEvent.change(screen.getByLabelText("Document title"), {target:{value:"Fresh draft"}});
  fireEvent.change(screen.getByLabelText("Private note body"), {target:{value:"Unsaved body"}});
  let finish!: (value: {Ok: bigint}) => void;
  vi.spyOn(x.actor, "account_balance").mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}));
  const mutate = vi.spyOn(x.actor, "mutate");
  fireEvent.click(screen.getByRole("button", {name:"Refresh Vaults"}));
  await waitFor(() => expect(finish).toBeDefined());
  await waitFor(() => expect(screen.getByRole("button", {name:"Refresh Vaults"})).toHaveProperty("disabled", false));
  const disabledWhileWaiting = (screen.getByRole("button", { name: "Save document" }) as HTMLButtonElement).disabled;
  if (disabledWhileWaiting) fireEvent.click(screen.getByRole("button", { name: "Save document" }));
  const callsWhileWaiting = mutate.mock.calls.length;
  await act(async () => finish({Ok:15_000_000n}));
  expect(disabledWhileWaiting).toBe(true);
  expect(callsWhileWaiting).toBe(0);
  expect(screen.getByRole("button", { name: "Save document" })).toHaveProperty("disabled", true);
  expect(screen.getByLabelText("Private note body")).toHaveProperty("value", "Unsaved body");
});

it("offers inline funding when an Available snapshot has insufficient latest balance", async () => {
  const x = await mounted();
  x.setBalance(15_000_000n);
  vi.spyOn(x.actor, "get_spending_status").mockResolvedValue({Ok:{Available:null}});
  fireEvent.click(screen.getByText("Refresh balance"));
  await screen.findByLabelText("Prepaid balance: 15,000,000 cycles");
  expect(screen.getByRole("button", {name:"Create Vault"})).toHaveProperty("disabled", true);
  expect(within(screen.getByRole("region", {name:"Choose a Vault"})).getByLabelText("KINIC amount")).toBeTruthy();
});
function memoryDeviceKeys() {
  const keys = new Map<string, CryptoKey>();
  return {
    epoch: async () => 0,
    get: async (binding: string) => keys.get(binding),
    put: async (binding: string, key: CryptoKey) => { keys.set(binding, key); return true; },
    forget: async () => keys.clear(),
    removeVault: async () => {},
    rollback: async () => {},
    subscribe: () => () => {},
  };
}
it("reopens the first owned Vault whose key is saved on this device", async () => {
  const identity = Ed25519KeyIdentity.generate();
  const network = fixtureNetwork(identity.getPrincipal(), Ed25519KeyIdentity.generate().getPrincipal());
  const deviceKeys = memoryDeviceKeys();
  const derive = vi.spyOn(network.actor, "derive_vault_key");
  const create = () => new VaultClient({ actor: network.actor, identity, canister: "rrkah-fqaaa-aaaaa-aaaaq-cai", local: true, deviceKeys });
  const first = create();
  const view = render(workspace(first));
  await screen.findByText("Vault 1");
  expect(screen.queryByLabelText("Document title")).toBeNull();
  expect(derive).not.toHaveBeenCalled();
  clickAndDiscard(screen.getByText("Vault 2"));
  await screen.findByLabelText("Document title");
  expect(derive).toHaveBeenCalledTimes(1);
  view.unmount();
  first.destroy();
  render(workspace(create()));
  await screen.findByLabelText("Document title");
  expect(screen.getByText("Vault 1").closest("button")?.getAttribute("aria-pressed")).toBe("false");
  expect(screen.getByText("Vault 2").closest("button")?.getAttribute("aria-pressed")).toBe("true");
  expect(derive).toHaveBeenCalledTimes(1);
});
