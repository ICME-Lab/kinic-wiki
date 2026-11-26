// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Item, VaultClient } from "@kinic/vault-client";
import type { Metadata } from "@kinic/vault-crypto/documents";
import { VaultDocuments } from "./documents";
import { PasswordGeneratorPanel } from "./credential-tools";

vi.mock("@kinic/ui/editor", () => ({ MarkdownEditor: () => <div /> }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function makeClient(overrides: Partial<VaultClient> = {}) {
  let ticket = 0;
  const cleanups = new Set<() => void>();
  const download = vi.fn();
  const save = vi.fn(async (metadata: Metadata, _plain: Uint8Array) => ({
    object: new Uint8Array(16).fill(9),
    revision: 1n,
    deleted: false,
    manifest: new Uint8Array(),
    chunk_count: 1,
    total_size: 10n,
    created_at: 1n,
    metadata,
  }));
  const read = vi.fn();
  const client = {
    session: {
      capture: () => ticket,
      check: (g: number) => {
        if (g !== ticket) throw Error("Locked");
      },
      addLockCleanup: (fn: () => void) => {
        cleanups.add(fn);
        return () => cleanups.delete(fn);
      },
      download,
    },
    save,
    read,
    searchNotes: vi.fn(),
    hasPendingSave: false,
    ...overrides,
  } as unknown as VaultClient;
  return {
    client,
    save,
    read,
    download,
    lock: () => {
      ticket++;
      for (const fn of cleanups) fn();
    },
  };
}

describe("VaultDocuments password manager features", () => {
  it("preserves custom fields when editing an imported credential and clears them for a new login", async () => {
    const { client, read, save } = makeClient();
    const metadata: Metadata = { kind: "credential", title: "Imported" };
    const item = { metadata, revision: { object: new Uint8Array(16).fill(1), revision: 1n, deleted: false } } as Item;
    const fields = [{ label: "Account", value: "  keep spaces  ", hidden: false }, { label: "Recovery", value: "private-secret", hidden: true }];
    read.mockImplementation(async () => ({ metadata, plaintext: new TextEncoder().encode(JSON.stringify({ username: "alice", password: "pw", customFields: fields })) }));
    const saved: unknown[] = [];
    save.mockImplementation(async (meta, plain) => {
      saved.push(JSON.parse(new TextDecoder().decode(plain)));
      return { object: new Uint8Array(16).fill(1), revision: 2n, deleted: false, manifest: new Uint8Array(), chunk_count: 1, total_size: 10n, created_at: 1n, metadata: meta };
    });
    render(<VaultDocuments onCommitted={vi.fn()} client={client} items={[item]} disabled={false} writesDisabled={false} refresh={async () => {}} run={f => { void f(); }} />);
    fireEvent.click(screen.getByRole("button", { name: "Imported" }));
    await waitFor(() => expect((screen.getByLabelText("Username") as HTMLInputElement).value).toBe("alice"));
    fireEvent.change(screen.getByLabelText("Document title"), { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save document" }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect((saved[0] as { customFields: unknown[] }).customFields).toEqual(fields);
    fireEvent.click(screen.getByRole("button", { name: "New document" }));
    fireEvent.change(screen.getByLabelText("Document type"), { target: { value: "credential" } });
    fireEvent.change(screen.getByLabelText("Document title"), { target: { value: "New login" } });
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "bob" } });
    fireEvent.click(screen.getByRole("button", { name: "Save document" }));
    await waitFor(() => expect(saved).toHaveLength(2));
    expect((saved[1] as { customFields?: unknown[] }).customFields).toBeUndefined();
  });

  it("keeps an import-owned pending save out of the editor recovery controls", async () => {
    const { client, save } = makeClient();
    save.mockImplementationOnce(async () => { Object.assign(client, { hasPendingSave: true }); throw Error("NetworkError"); });
    Object.assign(client, { resumeSave: async () => { Object.assign(client, { hasPendingSave: false }); return { revision: 1n }; } });
    render(<VaultDocuments onCommitted={vi.fn()} client={client} items={[]} disabled={false} writesDisabled={false} refresh={async () => {}} run={f => { void f(); }} />);
    fireEvent.click(screen.getByRole("button", { name: "Import / Export" }));
    const file = { name: "logins.csv", size: 60, text: async () => "name,url,username,password\nSite,https://site.test,alice,secret" };
    fireEvent.change(screen.getByLabelText("Select CSV or JSON file"), { target: { files: [file] } });
    fireEvent.click(await screen.findByRole("button", { name: "Import 1 item(s)" }));
    await screen.findByRole("button", { name: "Resolve import save" });
    expect(screen.queryByRole("button", { name: "Resume save" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel save" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Resolve import save" }));
    await screen.findByText(/Import save confirmed/);
    expect((screen.getByRole("button", { name: "Close import and export" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("filters by category and instant metadata fields (domain, username, tag) without body reads", () => {
    const items: Item[] = [
      {
        metadata: {
          kind: "credential",
          title: "GitHub",
          username: "alice@dev.example",
          domains: ["github.com"],
          hasTotp: true,
          favorite: true,
          tags: ["work"],
        },
        revision: { object: new Uint8Array(16).fill(1), revision: 1n, deleted: false } as Item["revision"],
      },
      {
        metadata: {
          kind: "note",
          title: "Runbook",
          tags: ["ops"],
        },
        revision: { object: new Uint8Array(16).fill(2), revision: 1n, deleted: false } as Item["revision"],
      },
    ];
    const { client } = makeClient();
    render(
      <VaultDocuments
        onCommitted={vi.fn()}
        client={client}
        items={items}
        disabled={false}
        writesDisabled={false}
        refresh={vi.fn(async () => {})}
        run={(f) => {
          void f();
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Search and filter documents" }));
    // Filter by Favorites
    fireEvent.click(screen.getByRole("button", { name: "Favorites" }));
    expect(screen.getByRole("button", { name: "GitHub" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Runbook" })).toBeNull();

    // Filter by Notes
    fireEvent.click(screen.getByRole("button", { name: "Notes" }));
    expect(screen.queryByRole("button", { name: "GitHub" })).toBeNull();
    expect(screen.getByRole("button", { name: "Runbook" })).toBeTruthy();

    // Search by domain & username with All selected
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    fireEvent.change(screen.getByLabelText("Search this Vault locally"), {
      target: { value: "github.com" },
    });
    expect(screen.getByRole("button", { name: "GitHub" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Runbook" })).toBeNull();
    expect(client.searchNotes).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Search this Vault locally"), {
      target: { value: "alice@dev" },
    });
    expect(screen.getByRole("button", { name: "GitHub" })).toBeTruthy();
  });

  it("saves extended credential metadata, generates passwords, and displays live TOTP", async () => {
    const { client, save } = makeClient();
    const refresh = vi.fn(async () => {});
    render(
      <VaultDocuments
        onCommitted={vi.fn()}
        client={client}
        items={[]}
        disabled={false}
        writesDisabled={false}
        refresh={refresh}
        run={(f) => {
          void f();
        }}
      />,
    );

    fireEvent.change(screen.getByLabelText("Document type"), {
      target: { value: "credential" },
    });
    fireEvent.change(screen.getByLabelText("Document title"), {
      target: { value: "GitHub" },
    });
    fireEvent.change(screen.getByLabelText("Username"), {
      target: { value: "alice@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Favorite" }));

    // Use password generator
    fireEvent.click(screen.getByRole("button", { name: "Generate password" }));
    fireEvent.click(screen.getByRole("button", { name: "Use password" }));
    const pwInput = screen.getByLabelText("Password") as HTMLInputElement;
    expect(pwInput.value.length).toBeGreaterThanOrEqual(12);

    // Enter TOTP secret and verify live 6-digit code renders
    fireEvent.change(screen.getByLabelText("Authenticator key (TOTP)"), {
      target: { value: "JBSWY3DPEHPK3PXP" },
    });
    await waitFor(() => {
      expect(screen.getByLabelText("One-time verification code")).toBeTruthy();
    });

    fireEvent.change(screen.getByLabelText("URL (stored as text)"), {
      target: { value: "https://github.com/login" },
    });
    fireEvent.change(screen.getByLabelText("Additional URLs (one per line)"), {
      target: { value: "https://gist.github.com" },
    });
    fireEvent.change(screen.getByLabelText("Tags (comma-separated)"), {
      target: { value: "work, dev" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Save document" }));

    await waitFor(() => {
      expect(save).toHaveBeenCalledTimes(1);
    });
    const [savedMetadata] = save.mock.calls[0];
    expect(savedMetadata).toEqual({
      kind: "credential",
      title: "GitHub",
      username: "alice@example.com",
      domains: ["github.com", "gist.github.com"],
      hasTotp: true,
      favorite: true,
      tags: ["work", "dev"],
    });
  });

  it("imports CSV credentials skipping duplicates and exports full vault JSON wiping plaintext", async () => {
    const existingItem: Item = {
      metadata: {
        kind: "credential",
        title: "Existing",
        username: "bob",
        domains: ["existing.test"],
      },
      revision: { object: new Uint8Array(16).fill(3), revision: 1n, deleted: false } as Item["revision"],
    };
    const { client, save, read, download } = makeClient();
    const decryptedBuffers: Uint8Array[] = [];
    read.mockImplementation(async () => {
      const plaintext = new TextEncoder().encode(
        JSON.stringify({
          label: "Existing",
          username: "bob",
          password: "secret",
          URL: "https://existing.test",
          notes: "",
        }),
      );
      decryptedBuffers.push(plaintext);
      return { metadata: existingItem.metadata, plaintext };
    });

    const refresh = vi.fn(async () => {});
    render(
      <VaultDocuments
        onCommitted={vi.fn()}
        client={client}
        items={[existingItem]}
        disabled={false}
        writesDisabled={false}
        refresh={refresh}
        run={(f) => {
          void f();
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Import / Export" }));
    const csvContent = [
      "name,url,username,password,note",
      "Existing,https://existing.test,bob,oldpw,",
      "NewSite,https://newsite.example/login,alice,newpw,hello",
    ].join("\n");
    const csvFile = {
      name: "chrome.csv",
      size: csvContent.length,
      text: async () => csvContent,
    } as unknown as File;
    const fileInput = screen.getByLabelText("Select CSV or JSON file");
    fireEvent.change(fileInput, { target: { files: [csvFile] } });

    await screen.findByRole("button", { name: "Import 1 item(s)" });
    fireEvent.click(screen.getByRole("button", { name: "Import 1 item(s)" }));

    await waitFor(() => {
      expect(save).toHaveBeenCalledTimes(1);
    });
    expect(save.mock.calls[0][0]).toEqual({
      kind: "credential",
      title: "NewSite",
      username: "alice",
      domains: ["newsite.example"],
    });

    // Switch to Export all tab and run JSON export
    fireEvent.click(screen.getByRole("button", { name: "Export all" }));
    fireEvent.click(screen.getByRole("button", { name: "Export all (JSON)" }));

    await waitFor(() => {
      expect(download).toHaveBeenCalledTimes(1);
    });
    expect(download.mock.calls[0][1]).toMatch(/^kinic-vault-export-\d{4}-\d{2}-\d{2}\.json$/);
    // Verify decrypted plaintext buffer was zeroed in finally!
    expect(decryptedBuffers[0].every((b) => b === 0)).toBe(true);
  });
});

it("shows the entropy of generated word choices in the passphrase preview", () => {
  const { client } = makeClient();
  render(<PasswordGeneratorPanel client={client} disabled={false} onUse={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Generate password" }));
  fireEvent.click(screen.getByRole("button", { name: "Passphrase" }));
  fireEvent.change(screen.getByRole("slider"), { target: { value: "3" } });
  fireEvent.click(screen.getByLabelText("Include number"));
  expect(screen.getByTitle("Estimated 33 bits of entropy").textContent).toBe("Weak");
  fireEvent.click(screen.getByLabelText("Capitalize"));
  expect(screen.getByTitle("Estimated 33 bits of entropy").textContent).toBe("Weak");
});
