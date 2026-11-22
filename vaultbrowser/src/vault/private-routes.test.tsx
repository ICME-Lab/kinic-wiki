// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
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
  vi.useRealTimers();
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
  shared = false,
) {
  const owner = Ed25519KeyIdentity.generate();
  const identity = shared ? Ed25519KeyIdentity.generate() : owner;
  const network = fixtureNetwork(identity.getPrincipal(), owner.getPrincipal());
  const options = {
    actor: network.actor,
    canister: "rrkah-fqaaa-aaaaa-aaaaq-cai",
    local: true,
  };
  const writer = new VaultClient({ ...options, identity: owner });
  const header = network.headers[0];
  await writer.open(header);
  const doc = await writer.save(
    { kind, title: "Private title" },
    new TextEncoder().encode(body),
  );
  if (shared) network.setRole(header.id, { Viewer: null });
  const client = shared ? new VaultClient({ ...options, identity }) : writer;
  return { ...network, client, writer, header, doc };
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
  expect(screen.queryByRole("button", { name: "Save document" })).toBeNull();
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

it("reveals only the selected login in an embedded credential", async () => {
  const { client, header, doc } = await privateDocument(
    "credential",
    JSON.stringify({
      username: "first",
      password: "First private password",
      additionalLogins: [{ username: "second", password: "Second private password" }],
    }),
  );
  render(<VaultEmbedDocument client={client} vault={bytes(header.id)} object={bytes(doc.object)} />);
  const first = within(await screen.findByRole("group", { name: "Login 1" }));
  const second = within(screen.getByRole("group", { name: "Login 2" }));
  expect(screen.queryByText(/private password/)).toBeNull();
  fireEvent.click(first.getByRole("button", { name: "Show credential" }));
  expect(first.getByText("First private password")).toBeTruthy();
  expect(screen.queryByText("Second private password")).toBeNull();
  fireEvent.click(second.getByRole("button", { name: "Show credential" }));
  expect(second.getByText("Second private password")).toBeTruthy();
  expect(screen.queryByText("First private password")).toBeNull();
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
    const access = vi.spyOn(network.actor, "get_vault_access");
    network.setRole(header.id, null);
    fireEvent.click(refresh);
    await vi.waitFor(() => expect(refresh.disabled).toBe(false));
    expect(
      screen.queryByRole("button", { name: "Shared document title" }),
    ).toBeNull();
    expect(client.session.root).toBeUndefined();
    expect(access).toHaveBeenCalledWith(bytes(header.id));
  },
);

it.each(["initial", "updated"])(
  "renders a slow %s revision after two same-head polls",
  async (phase) => {
    const { client, writer, header, doc, actor } = await privateDocument(
      "note",
      "### Original body",
      true,
    );
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const renderEmbed = () =>
      render(
        <VaultEmbedDocument
          client={client}
          vault={bytes(header.id)}
          object={bytes(doc.object)}
        />,
      );
    if (phase === "updated") {
      renderEmbed();
      await screen.findByRole("heading", { name: "Original body" });
      await writer.save(
        { kind: "note", title: "Updated title" },
        new TextEncoder().encode("### Updated body"),
        { revision: doc, metadata: { kind: "note", title: "Private title" } },
      );
    }

    const fetchChunk = actor.shared_get_chunk;
    const releases: Array<() => void> = [];
    const chunk = vi
      .spyOn(actor, "shared_get_chunk")
      .mockImplementation(async (...args) => {
        // Capture ciphertext at request time. Each later poll's fetch has its own delay.
        const reply = await fetchChunk(...args);
        await new Promise<void>((resolve) => releases.push(resolve));
        return reply;
      });
    const head = vi.spyOn(actor, "shared_get_manifest");
    try {
      if (phase === "updated") fireEvent(window, new Event("focus"));
      else renderEmbed();
      await vi.waitFor(() => expect(releases).toHaveLength(1));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_001);
      });
      await vi.waitFor(() =>
        expect(head.mock.calls.length).toBeGreaterThanOrEqual(3),
      );
      await act(async () => {
        releases[0]();
      });
      await screen.findByRole("heading", {
        name: phase === "updated" ? "Updated body" : "Original body",
      });
      expect(chunk).toHaveBeenCalledOnce();
    } finally {
      await act(async () => {
        for (const release of releases) release();
      });
    }
  },
);

it.each(["revocation", "deletion"])(
  "clears the displayed revision when a poll sees %s during a stalled newer fetch",
  async (action) => {
    const { client, writer, header, doc, actor, setRole } =
      await privateDocument("note", "### Visible private body", true);
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    render(
      <VaultEmbedDocument
        client={client}
        vault={bytes(header.id)}
        object={bytes(doc.object)}
      />,
    );
    await screen.findByRole("heading", { name: "Visible private body" });
    const next = await writer.save(
      { kind: "note", title: "New private title" },
      new TextEncoder().encode("### Stalled private body"),
      { revision: doc, metadata: { kind: "note", title: "Private title" } },
    );
    const original = actor.shared_get_chunk;
    let release!: () => void;
    const pause = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chunk = vi
      .spyOn(actor, "shared_get_chunk")
      .mockImplementation(async (...args) => {
        const reply = await original(...args);
        await pause;
        return reply;
      });
    try {
      fireEvent(window, new Event("focus"));
      await vi.waitFor(() => expect(chunk).toHaveBeenCalledOnce());
      if (action === "revocation") setRole(header.id, null);
      else await writer.deleteObject(next);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_001);
      });
      await screen.findByText("This private document is unavailable.");
      expect(screen.queryByText("Visible private body")).toBeNull();
      expect(client.session.root).toBeUndefined();
    } finally {
      await act(async () => {
        release();
      });
    }
    expect(screen.queryByText("New private title")).toBeNull();
    expect(screen.queryByText("Stalled private body")).toBeNull();
  },
);

it("loads a newer head while the superseded revision's body is stalled", async () => {
  const { client, writer, header, doc, actor } = await privateDocument(
    "note",
    "### Superseded body",
    true,
  );
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  const original = actor.shared_get_chunk;
  let release!: () => void;
  const pause = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chunk = vi
    .spyOn(actor, "shared_get_chunk")
    .mockImplementation(async (...args) => {
      const reply = await original(...args);
      if (args[2] === doc.revision) await pause;
      return reply;
    });
  try {
    render(
      <VaultEmbedDocument
        client={client}
        vault={bytes(header.id)}
        object={bytes(doc.object)}
      />,
    );
    await vi.waitFor(() => expect(chunk).toHaveBeenCalledOnce());
    await writer.save(
      { kind: "note", title: "Latest title" },
      new TextEncoder().encode("### Latest body"),
      { revision: doc, metadata: { kind: "note", title: "Private title" } },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_001);
    });
    await screen.findByRole("heading", { name: "Latest body" });
    expect(chunk).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => {
      release();
    });
  }
  expect(screen.getByText("Latest title")).toBeTruthy();
  expect(screen.queryByText("Superseded body")).toBeNull();
});
