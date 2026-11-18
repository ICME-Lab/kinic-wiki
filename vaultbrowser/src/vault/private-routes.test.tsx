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
import { bytes, VaultClient } from "@kinic/vault-client";
import { importKey } from "@kinic/vault-crypto";
import { fixtureHeader, fixtureNetwork } from "../../fixtures/network";
import { VaultPickerPage } from "./picker";
import { VaultEmbedDocument } from "./embed";
import {
  connectWikiPicker,
  parseVaultRoute,
  sendVaultSelection,
} from "./routes";

vi.mock("../../../packages/vault-crypto/src/context.ts", async (load) => ({
  ...(await load<
    typeof import("../../../packages/vault-crypto/src/context.ts")
  >()),
  verifiedRoot: async () => importKey(new Uint8Array(32).fill(8)),
}));

const pickerContext = vi.hoisted(() => ({
  client: undefined as VaultClient | undefined,
}));
vi.mock("../auth", () => ({
  useVaultAuth: () => ({
    identity: pickerContext.client?.identity,
    ready: true,
  }),
}));
vi.mock("./actor", () => ({
  createPrivateVaultClient: async () => pickerContext.client,
}));
vi.mock("../config", async (load) => ({
  ...(await load<typeof import("../config")>()),
  loadConfig: async () => ({ local: false }),
}));

afterEach(() => {
  cleanup();
  pickerContext.client = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const wiki = "https://wiki.kinic.xyz";
const vaultId = "01".repeat(16),
  objectId = "ab".repeat(16);

it("matches only exact lowercase Vault reference IDs and isolates invalid embed paths", () => {
  expect(parseVaultRoute(`/embed/${vaultId}/${objectId}`)).toEqual({
    kind: "embed",
    ids: { vault: vaultId, object: objectId },
  });
  for (const path of [
    "/embed",
    "/embed/",
    `/embed/${vaultId}/${objectId}/`,
    `/embed/${vaultId}/${objectId.toUpperCase()}`,
    `/embed/${vaultId}/%61${objectId.slice(1)}`,
  ]) {
    expect(parseVaultRoute(path)).toEqual({ kind: "embed" });
  }
  expect(parseVaultRoute("/pick")).toEqual({ kind: "picker" });
  expect(parseVaultRoute("/pick/else")).toEqual({ kind: "workspace" });
});

it("connects only to the Wiki opener at the configured origin and posts exact ID-only data", () => {
  const opener = { postMessage: vi.fn(), closed: false } as unknown as Window;
  vi.stubGlobal("opener", opener);
  const accepted = vi.fn();
  const close = connectWikiPicker(wiki, accepted);
  expect(opener.postMessage).toHaveBeenCalledWith(
    { type: "kinic-vault-picker-ready" },
    wiki,
  );
  const message = (origin: string, source: Window, data: unknown) =>
    window.dispatchEvent(new MessageEvent("message", { origin, source, data }));
  const hello = { type: "kinic-vault-picker-connect" };
  message("https://example.com", opener, hello);
  message(wiki, window, hello);
  message(wiki, opener, { ...hello, extra: true });
  expect(accepted).not.toHaveBeenCalled();
  message(wiki, opener, hello);
  const connection = accepted.mock.calls[0][0];
  const ids = { vault: vaultId, object: objectId, title: "Private title" };
  expect(sendVaultSelection(connection, ids)).toBe(true);
  expect(opener.postMessage).toHaveBeenLastCalledWith(
    {
      type: "kinic-vault-selection",
      vault: vaultId,
      object: objectId,
    },
    wiki,
  );
  expect(
    sendVaultSelection(connection, {
      vault: vaultId,
      object: objectId.toUpperCase(),
    }),
  ).toBe(false);
  expect(
    sendVaultSelection(connection, { vault: vaultId, object: objectId + "\n" }),
  ).toBe(false);
  vi.stubGlobal("opener", window);
  expect(sendVaultSelection(connection, ids)).toBe(false);
  close();
});

async function privateDocument(
  kind: "note" | "credential" | "attachment",
  body: string,
) {
  const identity = Ed25519KeyIdentity.generate();
  const network = fixtureNetwork(identity.getPrincipal());
  const client = new VaultClient({
    actor: network.actor,
    identity,
    canister: "rrkah-fqaaa-aaaaa-aaaaq-cai",
    local: true,
  });
  const header = network.headers[0];
  await client.open(header);
  const doc = await client.save(
    { kind, title: "Private title" },
    new TextEncoder().encode(body),
  );
  return { ...network, client, header, doc };
}

it("renders read-only Markdown and removes private content on focus after revocation", async () => {
  const { client, header, doc, setRole } = await privateDocument(
    "note",
    "### Private body",
  );
  render(
    <VaultEmbedDocument
      client={client}
      vault={bytes(header.id)}
      object={bytes(doc.object)}
    />,
  );
  await screen.findByRole("heading", { name: "Private body" });
  expect(screen.queryByText("Save document")).toBeNull();
  setRole(header.id, null);
  fireEvent(window, new Event("focus"));
  await screen.findByText("This private document is unavailable.");
  expect(screen.queryByText("Private title")).toBeNull();
  expect(screen.queryByText("Private body")).toBeNull();
  expect(client.session.root).toBeUndefined();
});

it("fences a late plaintext operation on session lock", async () => {
  const { client, header, doc, actor } = await privateDocument(
    "note",
    "Late private body",
  );
  const actual = actor.shared_get_chunk;
  let resolve!: () => void;
  const gate = new Promise<void>((r) => {
    resolve = r;
  });
  const chunk = vi
    .spyOn(actor, "shared_get_chunk")
    .mockImplementation(async (...args) => {
      const result = await actual(...args);
      await gate;
      return result;
    });
  render(
    <VaultEmbedDocument
      client={client}
      vault={bytes(header.id)}
      object={bytes(doc.object)}
    />,
  );
  await vi.waitFor(() => expect(chunk).toHaveBeenCalledOnce());
  act(() => client.session.lock());
  await act(async () => {
    resolve();
    await gate;
  });
  expect(screen.queryByText("Late private body")).toBeNull();
  expect(screen.queryByText("Private title")).toBeNull();
});

it("keeps passwords out of the DOM until explicitly revealed", async () => {
  const { client, header, doc } = await privateDocument(
    "credential",
    JSON.stringify({ username: "member", password: "Private password" }),
  );
  render(
    <VaultEmbedDocument
      client={client}
      vault={bytes(header.id)}
      object={bytes(doc.object)}
    />,
  );
  const show = await screen.findByRole("button", { name: "Show credential" });
  expect(screen.queryByText("Private password")).toBeNull();
  expect(screen.queryByText("member")).toBeNull();
  fireEvent.click(show);
  expect(screen.getByText("Private password")).toBeTruthy();
  expect(screen.getByText("member")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Hide credential" }));
  expect(screen.queryByText("Private password")).toBeNull();
});

it("uses an explicit Vault-origin attachment download and clears late bytes", async () => {
  const { client, header, doc, actor } = await privateDocument(
    "attachment",
    "attachment data",
  );
  const chunk = vi.spyOn(actor, "shared_get_chunk");
  const download = vi
    .spyOn(client.session, "download")
    .mockImplementation(() => {});
  render(
    <VaultEmbedDocument
      client={client}
      vault={bytes(header.id)}
      object={bytes(doc.object)}
    />,
  );
  const button = await screen.findByRole("button", {
    name: "Download attachment",
  });
  expect(chunk).not.toHaveBeenCalled();
  expect(download).not.toHaveBeenCalled();
  fireEvent.click(button);
  await vi.waitFor(() => expect(download).toHaveBeenCalledOnce());
  expect(chunk).toHaveBeenCalledOnce();
  expect(Array.from(download.mock.calls[0][0])).toEqual(Array(15).fill(0));
});

it.each([
  ["soft delete", "focus"],
  ["purge", "visibilitychange"],
] as const)(
  "clears an open embed on %s observed by %s while Vault access remains valid",
  async (action, event) => {
    const { client, header, doc, actor } = await privateDocument(
      "note",
      "### Shared body",
    );
    render(
      <VaultEmbedDocument
        client={client}
        vault={bytes(header.id)}
        object={bytes(doc.object)}
      />,
    );
    await screen.findByRole("heading", { name: "Shared body" });
    if (action === "purge") await client.purgeObject(doc);
    else await client.deleteObject(doc);
    const access = await actor.get_vault_access(header.id);
    expect("Ok" in access).toBe(true);
    fireEvent(event === "focus" ? window : document, new Event(event));
    await screen.findByText("This private document is unavailable.");
    expect(screen.queryByText("Private title")).toBeNull();
    expect(screen.queryByText("Shared body")).toBeNull();
    expect(client.session.root).toBeUndefined();
  },
);

it("checks the head again before rendering a body fetched before the document was deleted", async () => {
  const { client, header, doc, actor } = await privateDocument(
    "note",
    "Fetched before deletion",
  );
  const fetchChunk = actor.shared_get_chunk;
  let resolve!: () => void;
  const gate = new Promise<void>((done) => {
    resolve = done;
  });
  const chunk = vi
    .spyOn(actor, "shared_get_chunk")
    .mockImplementation(async (...args) => {
      const reply = await fetchChunk(...args);
      await gate;
      return reply;
    });
  render(
    <VaultEmbedDocument
      client={client}
      vault={bytes(header.id)}
      object={bytes(doc.object)}
    />,
  );
  await vi.waitFor(() => expect(chunk).toHaveBeenCalledOnce());
  try {
    await client.deleteObject(doc);
  } finally {
    resolve();
  }
  await screen.findByText("This private document is unavailable.");
  expect(screen.queryByText("Fetched before deletion")).toBeNull();
});

it("refreshes an unpinned embed to a newer active revision on focus", async () => {
  const { client, header, doc } = await privateDocument(
    "note",
    "### Previous body",
  );
  render(
    <VaultEmbedDocument
      client={client}
      vault={bytes(header.id)}
      object={bytes(doc.object)}
    />,
  );
  await screen.findByRole("heading", { name: "Previous body" });
  await client.save(
    { kind: "note", title: "New title" },
    new TextEncoder().encode("### New body"),
    { revision: doc, metadata: { kind: "note", title: "Private title" } },
  );
  fireEvent(window, new Event("focus"));
  await screen.findByRole("heading", { name: "New body" });
  expect(screen.getByText("New title")).toBeTruthy();
  expect(screen.queryByText("Previous body")).toBeNull();
  expect(screen.queryByText("Private title")).toBeNull();
});

it.each([1, 21])(
  "clears private picker titles when refresh sees revocation of Vault %i",
  async (position) => {
    const opener = { postMessage: vi.fn(), closed: false } as unknown as Window;
    vi.stubGlobal("opener", opener);
    const member = Ed25519KeyIdentity.generate();
    const owner = Ed25519KeyIdentity.generate();
    const network = fixtureNetwork(member.getPrincipal(), owner.getPrincipal());
    for (let value = 3; value <= (position > 20 ? 22 : 2); value++)
      network.headers.push(fixtureHeader(value));
    const header = network.headers[position - 1];
    const canister = "rrkah-fqaaa-aaaaa-aaaaq-cai";
    const writer = new VaultClient({
      actor: network.actor,
      identity: owner,
      canister,
      local: true,
    });
    await writer.open(header);
    await writer.save(
      { kind: "note", title: "Shared document title" },
      new Uint8Array([1]),
    );
    writer.destroy();
    network.setRole(header.id, { Viewer: null });
    const client = new VaultClient({
      actor: network.actor,
      identity: member,
      canister,
      local: true,
    });
    pickerContext.client = client;
    render(<VaultPickerPage />);
    await vi.waitFor(() => expect(opener.postMessage).toHaveBeenCalledOnce());
    fireEvent(
      window,
      new MessageEvent("message", {
        source: opener,
        origin: wiki,
        data: { type: "kinic-vault-picker-connect" },
      }),
    );
    if (position > 20)
      fireEvent.click(
        await screen.findByRole("button", { name: "Load more Vaults" }),
      );
    fireEvent.click(
      await screen.findByRole("button", { name: `Vault ${position} · Viewer` }),
    );
    await screen.findByRole("button", { name: "Shared document title" });
    const refresh = screen.getByRole("button", {
      name: "Refresh Vaults",
    }) as HTMLButtonElement;
    if (position > 20) {
      fireEvent.click(refresh);
      await vi.waitFor(() => expect(refresh.disabled).toBe(false));
      expect(
        screen.getByRole("button", { name: "Shared document title" }),
      ).toBeTruthy();
    }
    network.setRole(header.id, null);
    fireEvent.click(refresh);
    await vi.waitFor(() => expect(refresh.disabled).toBe(false));
    expect(
      screen.queryByRole("button", { name: "Shared document title" }),
    ).toBeNull();
    expect(client.session.root).toBeUndefined();
  },
);
