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
import { fixtureNetwork } from "../../fixtures/network";
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

afterEach(() => {
  cleanup();
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
