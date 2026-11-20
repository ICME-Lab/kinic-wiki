import type { Identity } from "@icp-sdk/core/agent";
import type { Item } from "@kinic/vault-client";
import type { Header, Revision } from "@kinic/vault-client/contracts";
import { Session } from "@kinic/vault-client/session";
import {
  buildCredentialMetadata,
  serializeCredential
} from "@kinic/vault-crypto/credential";
import { describe, expect, it, vi } from "vitest";
import { VaultEngine, bytesToHex, type VaultClientLike } from "../src/vault-engine.ts";

function makeBytes(fill: number): Uint8Array {
  return new Uint8Array(16).fill(fill);
}

function makeHeader(fill: number, name: string): Header {
  return {
    id: makeBytes(fill),
    public_key: new Uint8Array(48).fill(1),
    name: [name],
    state: { Active: null },
    nonce: new Uint8Array(16).fill(2),
    key_name: "key_1",
    sequence: 1n
  };
}

function makeMockClient() {
  const session = new Session();
  const ownedHeader = makeHeader(0x11, "Personal");
  const sharedHeader = makeHeader(0x22, "Team Shared");

  const stored = new Map<string, { item: Item; plaintext: Uint8Array }>();

  const seed = (
    objFill: number,
    record: {
      title: string;
      username: string;
      password: string;
      url: string;
      totp?: string;
      favorite?: boolean;
      tags?: string[];
    }
  ) => {
    const object = makeBytes(objFill);
    const metadata = buildCredentialMetadata(record.title, {
      label: record.title,
      username: record.username,
      password: record.password,
      URL: record.url,
      urls: [record.url],
      totp: record.totp ?? "",
      favorite: record.favorite ?? false,
      tags: record.tags ?? []
    });
    const revision: Revision = {
      deleted: false,
      object,
      vault: ownedHeader.id,
      chunk_hashes: [new Uint8Array(32).fill(objFill)],
      revision: 1n,
      manifest: new Uint8Array([1, 2, 3]),
      plain_size: 100n,
      sequence: BigInt(objFill)
    };
    const plaintext = new TextEncoder().encode(
      serializeCredential({
        label: record.title,
        username: record.username,
        password: record.password,
        URL: record.url,
        urls: [record.url],
        totp: record.totp ?? "",
        favorite: record.favorite ?? false,
        tags: record.tags ?? []
      })
    );
    stored.set(bytesToHex(object), { item: { revision, metadata }, plaintext });
  };

  seed(0x01, {
    title: "GitHub Main",
    username: "alice@example.com",
    password: "existing-password",
    url: "https://github.com/login",
    totp: "JBSWY3DPEHPK3PXP",
    favorite: true,
    tags: ["dev"]
  });
  seed(0x02, {
    title: "GitHub Gist",
    username: "gist-user",
    password: "gist-password",
    url: "https://gist.github.com"
  });
  seed(0x03, {
    title: "Example Bank",
    username: "alice-bank",
    password: "bank-password",
    url: "https://bank.example.org"
  });

  const client: VaultClientLike = {
    actor: {
      initialize_vault_account: vi.fn(async () => ({
        Ok: { balance: 1n, grant_cycles: 1n }
      }))
    } as unknown as VaultClientLike["actor"],
    session,
    destroy: vi.fn(() => session.lock()),
    forgetDeviceKeys: vi.fn(async () => {}),
    listVaults: vi.fn(async () => [ownedHeader]),
    listAccessibleVaults: vi.fn(async () => ({
      next: [] as [],
      entries: [
        {
          owner: {} as never,
          role: { Viewer: null },
          header: sharedHeader
        }
      ]
    })),
    create: vi.fn(async () => makeHeader(0x33, "New Vault")),
    open: vi.fn(async () => {
      session.root = {} as CryptoKey;
    }),
    openAccess: vi.fn(async () => {
      session.root = {} as CryptoKey;
    }),
    items: vi.fn(async () => [...stored.values()].map((entry) => entry.item)),
    read: vi.fn(async (rev: Revision) => {
      const entry = stored.get(bytesToHex(rev.object));
      if (!entry) throw new Error("NotFound");
      return {
        metadata: entry.item.metadata,
        plaintext: new Uint8Array(entry.plaintext)
      };
    }),
    save: vi.fn(async (metadata, plaintext, existing) => {
      const object = existing ? existing.revision.object : makeBytes(0x99);
      const revNum = existing ? existing.revision.revision + 1n : 1n;
      const revision: Revision = {
        deleted: false,
        object,
        vault: ownedHeader.id,
        chunk_hashes: [new Uint8Array(32).fill(9)],
        revision: revNum,
        manifest: new Uint8Array([4, 5, 6]),
        plain_size: BigInt(plaintext.length),
        sequence: 99n
      };
      stored.set(bytesToHex(object), {
        item: { revision, metadata },
        plaintext: new Uint8Array(plaintext)
      });
      return revision;
    }),
    deleteObject: vi.fn(async (rev: Revision) => {
      stored.delete(bytesToHex(rev.object));
      return { Done: null };
    })
  };

  return { client, ownedHeader, sharedHeader };
}

describe("VaultEngine", () => {
  it("lists owned and shared vaults, ranks domain matches, decrypts TOTP, and supports CRUD", async () => {
    const { client, ownedHeader } = makeMockClient();
    const fakeIdentity = {
      getPrincipal: () => ({
        isAnonymous: () => false,
        toText: () => "aaaaa-aa"
      })
    } as unknown as Identity;

    const engine = new VaultEngine({
      authSnapshot: async () => ({
        isAuthenticated: true,
        identity: fakeIdentity,
        principal: "aaaaa-aa"
      }),
      resetAuthClient: async () => {},
      createVaultClient: async () => client,
      now: () => 1_700_000_000_000
    });

    const vaults = await engine.listVaults();
    expect(vaults).toHaveLength(2);
    expect(vaults[0]).toMatchObject({ name: "Personal", role: "Owner", canWrite: true });
    expect(vaults[1]).toMatchObject({ name: "Team Shared", role: "Viewer", canWrite: false });

    const unlocked = await engine.unlockVault(bytesToHex(ownedHeader.id));
    expect(unlocked.isUnlocked).toBe(true);
    expect(unlocked.itemCount).toBe(3);

    // Exact domain match (gist.github.com) ranks ahead of parent domain (github.com).
    const gistLookup = engine.listItems({ url: "https://gist.github.com/login" });
    expect(gistLookup.matches.map((item) => item.title)).toEqual([
      "GitHub Gist",
      "GitHub Main"
    ]);

    // Decryption computes live 6-digit TOTP code.
    const githubId = bytesToHex(makeBytes(0x01));
    const decrypted = await engine.readItem(githubId);
    expect(decrypted.username).toBe("alice@example.com");
    expect(decrypted.password).toBe("existing-password");
    expect(decrypted.totp?.code).toMatch(/^\d{6}$/);
    expect(decrypted.totp?.formattedCode).toMatch(/^\d{3} \d{3}$/);

    // Evaluate submitted logins: identical -> ignore; changed password -> update; new user -> create.
    expect(
      await engine.evaluateSubmittedLogin({
        url: "https://github.com/login",
        username: "alice@example.com",
        password: "existing-password"
      })
    ).toEqual({ action: "ignore" });

    expect(
      await engine.evaluateSubmittedLogin({
        url: "https://github.com/login",
        username: "alice@example.com",
        password: "brand-new-password"
      })
    ).toMatchObject({
      action: "update",
      existingObjectIdHex: githubId,
      domain: "github.com"
    });

    expect(
      await engine.evaluateSubmittedLogin({
        url: "https://newsite.example/login",
        username: "new@example.com",
        password: "fresh-password",
        pageTitle: "NewSite"
      })
    ).toEqual({
      action: "create",
      domain: "newsite.example",
      title: "NewSite"
    });

    // Save new login & delete it.
    const saved = await engine.saveCredential({
      title: "NewSite",
      username: "new@example.com",
      password: "fresh-password",
      url: "https://newsite.example/login"
    });
    expect(saved.domains).toEqual(["newsite.example"]);
    expect(engine.listItems({ url: "https://newsite.example" }).matches).toHaveLength(1);

    await engine.deleteItem(saved.objectIdHex);
    expect(engine.listItems({ url: "https://newsite.example" }).matches).toHaveLength(0);

    // Lock clears decrypted session state.
    const locked = engine.lockVault();
    expect(locked.isUnlocked).toBe(false);
    expect(locked.itemCount).toBe(0);
    expect(engine.getMatchesForUrl("https://github.com").unlocked).toBe(false);
  });

  it("wipes persisted device keys on forgetAndReset even when no VaultClient is active", async () => {
    const clearPersistedDeviceKeys = vi.fn(async () => {});
    const resetAuthClient = vi.fn(async () => {});
    const engine = new VaultEngine({
      authSnapshot: async () => ({
        isAuthenticated: false,
        identity: null,
        principal: null
      }),
      clearPersistedDeviceKeys,
      resetAuthClient
    });

    await engine.forgetAndReset();
    expect(clearPersistedDeviceKeys).toHaveBeenCalledTimes(1);
    expect(resetAuthClient).toHaveBeenCalledTimes(1);
  });
});
