// Where: extensions/vault-autofill/src/vault-engine.ts
// What: Encrypted Kinic Vault runtime engine backed by @kinic/vault-client and @kinic/vault-crypto.
// Why: Keep decryption keys and item metadata strictly in memory inside the DOM-capable offscreen page,
//      never persisting secrets in chrome.storage.local or exposing passwords proactively to web pages.
import { Actor, HttpAgent, type Identity } from "@icp-sdk/core/agent";
import { idlFactory } from "@kinic/vault-candid";
import { VaultClient, bytes, type Item } from "@kinic/vault-client";
import type { Header, VaultActor } from "@kinic/vault-client/contracts";
import {
  MAX_CREDENTIAL_DOMAINS,
  buildCredentialMetadata,
  credentialLogins,
  extractDomains,
  matchesDomain,
  matchesMetadataQuery,
  normalizeDomain,
  parseCredential,
  serializeCredential
} from "@kinic/vault-crypto/credential";
import { formatTotpCode, generateTotp } from "@kinic/vault-crypto/totp";
import {
  authSnapshot as defaultAuthSnapshot,
  resetAuthClient as defaultResetAuthClient,
  type AuthSnapshot
} from "./auth-client.ts";
import {
  RUNTIME_CONFIG,
  validateVaultRuntimeConfig,
  type VaultRuntimeConfig
} from "./runtime-config.ts";
import type {
  DecryptedItemView,
  ItemCategoryFilter,
  LiveTotpView,
  SaveCredentialInput,
  VaultEngineState,
  VaultItemSummary,
  VaultLoginMatch,
  VaultLoginTarget,
  VaultSummary
} from "./types.ts";

export type VaultClientLike = Pick<
  VaultClient,
  | "actor"
  | "session"
  | "destroy"
  | "forgetDeviceKeys"
  | "listVaults"
  | "listAccessibleVaults"
  | "create"
  | "open"
  | "openAccess"
  | "items"
  | "read"
  | "save"
  | "deleteObject"
>;

type VaultEntry = {
  summary: VaultSummary;
  header: Header;
};

type EngineDeps = {
  authSnapshot: () => Promise<AuthSnapshot>;
  resetAuthClient: () => void | Promise<void>;
  createVaultClient: (
    identity: Identity,
    config: VaultRuntimeConfig
  ) => Promise<VaultClientLike>;
  clearPersistedDeviceKeys: () => Promise<void>;
  now: () => number;
  config: VaultRuntimeConfig;
};

const DEVICE_KEYS_DB_NAME = "kinic-vault-device-keys-v1";

async function defaultClearPersistedDeviceKeys(): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  await new Promise<void>((resolve) => {
    try {
      const request = indexedDB.deleteDatabase(DEVICE_KEYS_DB_NAME);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
}

async function defaultCreateVaultClient(
  identity: Identity,
  config: VaultRuntimeConfig
): Promise<VaultClientLike> {
  const validated = validateVaultRuntimeConfig(config);
  const agent = HttpAgent.createSync({
    host: validated.icHost,
    identity
  });
  if (validated.local) {
    await agent.fetchRootKey();
  }
  const actor = Actor.createActor<VaultActor>(idlFactory, {
    agent,
    canisterId: validated.canisterId
  });
  return new VaultClient({
    actor,
    identity,
    canister: validated.canisterId,
    local: validated.local
  });
}

export function bytesToHex(input: Uint8Array | number[]): string {
  const view = bytes(input);
  let out = "";
  for (let i = 0; i < view.length; i++) {
    out += view[i].toString(16).padStart(2, "0");
  }
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(clean) || clean.length % 2 !== 0) {
    throw new Error("Invalid hex identifier.");
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function defaultVaultName(header: Header): string {
  const raw = header.name[0]?.trim();
  if (raw) return raw;
  return `Vault ${bytesToHex(header.id).slice(0, 6)}`;
}

function mapRole(role: { Owner?: null; Editor?: null; Viewer?: null }): "Owner" | "Editor" | "Viewer" {
  if ("Owner" in role) return "Owner";
  if ("Editor" in role) return "Editor";
  return "Viewer";
}

function domainMatchScore(domains: readonly string[], targetHost: string): number {
  let best = 0;
  for (const raw of domains) {
    const domain = raw.toLowerCase();
    if (domain === targetHost) {
      best = Math.max(best, 3);
    } else if (targetHost.endsWith(`.${domain}`)) {
      best = Math.max(best, 2);
    } else if (domain.endsWith(`.${targetHost}`)) {
      best = Math.max(best, 1);
    }
  }
  return best;
}

export class VaultEngine {
  private deps: EngineDeps;
  private client: VaultClientLike | null = null;
  private principal: string | null = null;
  private vaults = new Map<string, VaultEntry>();
  private activeVaultIdHex: string | null = null;
  private cachedItems = new Map<string, Item>();
  private unlockedAtMs: number | null = null;

  constructor(deps: Partial<EngineDeps> = {}) {
    this.deps = {
      authSnapshot: deps.authSnapshot ?? defaultAuthSnapshot,
      resetAuthClient: deps.resetAuthClient ?? defaultResetAuthClient,
      createVaultClient: deps.createVaultClient ?? defaultCreateVaultClient,
      clearPersistedDeviceKeys:
        deps.clearPersistedDeviceKeys ?? defaultClearPersistedDeviceKeys,
      now: deps.now ?? (() => Date.now()),
      config: deps.config ?? RUNTIME_CONFIG
    };
  }

  private clearUnlockedState(): void {
    this.cachedItems.clear();
    this.unlockedAtMs = null;
  }

  private destroyClient(): void {
    this.clearUnlockedState();
    this.vaults.clear();
    this.activeVaultIdHex = null;
    this.principal = null;
    if (this.client) {
      try {
        this.client.destroy();
      } catch {
        // Ignore cleanup errors during teardown.
      }
      this.client = null;
    }
  }

  private async ensureAuthenticatedClient(): Promise<{
    client: VaultClientLike;
    principal: string;
  }> {
    let snapshot = await this.deps.authSnapshot();
    if (!snapshot.isAuthenticated || !snapshot.identity || !snapshot.principal) {
      await this.deps.resetAuthClient();
      snapshot = await this.deps.authSnapshot();
    }
    if (!snapshot.isAuthenticated || !snapshot.identity || !snapshot.principal) {
      this.destroyClient();
      throw new Error("UNAUTHENTICATED");
    }
    if (this.client && this.principal === snapshot.principal) {
      return { client: this.client, principal: snapshot.principal };
    }
    this.destroyClient();
    const client = await this.deps.createVaultClient(
      snapshot.identity,
      this.deps.config
    );
    client.session.onLock = () => {
      this.clearUnlockedState();
    };
    this.client = client;
    this.principal = snapshot.principal;
    return { client, principal: snapshot.principal };
  }

  private isVaultCurrentlyUnlocked(): boolean {
    if (!this.client || !this.activeVaultIdHex) return false;
    this.client.session.expire(this.deps.now());
    return Boolean(this.client.session.root);
  }

  private requireUnlockedVault(): {
    client: VaultClientLike;
    vault: VaultEntry;
  } {
    if (!this.isVaultCurrentlyUnlocked() || !this.client || !this.activeVaultIdHex) {
      this.clearUnlockedState();
      throw new Error("VAULT_LOCKED");
    }
    const vault = this.vaults.get(this.activeVaultIdHex);
    if (!vault) {
      this.clearUnlockedState();
      throw new Error("VAULT_LOCKED");
    }
    this.client.session.activity();
    return { client: this.client, vault };
  }

  private toItemSummary(item: Item): VaultItemSummary {
    return {
      objectIdHex: bytesToHex(item.revision.object),
      vaultIdHex: bytesToHex(item.revision.vault),
      revision: item.revision.revision.toString(),
      kind: item.metadata.kind,
      title: item.metadata.title,
      username: item.metadata.username ?? "",
      domains: item.metadata.domains ? [...item.metadata.domains] : [],
      hasTotp: Boolean(item.metadata.hasTotp),
      favorite: Boolean(item.metadata.favorite),
      tags: item.metadata.tags ? [...item.metadata.tags] : [],
      updatedAtMs: Number(item.revision.sequence)
    };
  }

  async authStatus(): Promise<{ isAuthenticated: boolean; principal: string | null }> {
    let snapshot = await this.deps.authSnapshot();
    if (!snapshot.isAuthenticated || !snapshot.principal) {
      await this.deps.resetAuthClient();
      snapshot = await this.deps.authSnapshot();
    }
    if (!snapshot.isAuthenticated || !snapshot.principal) {
      this.destroyClient();
      return { isAuthenticated: false, principal: null };
    }
    return { isAuthenticated: true, principal: snapshot.principal };
  }

  async getState(): Promise<VaultEngineState> {
    const auth = await this.authStatus();
    if (!auth.isAuthenticated) {
      return {
        isAuthenticated: false,
        principal: null,
        vaults: [],
        activeVaultIdHex: null,
        activeVaultName: null,
        activeVaultCanWrite: false,
        isUnlocked: false,
        itemCount: 0,
        unlockedAtMs: null
      };
    }
    const unlocked = this.isVaultCurrentlyUnlocked();
    const active = this.activeVaultIdHex
      ? this.vaults.get(this.activeVaultIdHex) ?? null
      : null;
    return {
      isAuthenticated: true,
      principal: auth.principal,
      vaults: [...this.vaults.values()].map((entry) => entry.summary),
      activeVaultIdHex: active?.summary.idHex ?? null,
      activeVaultName: active?.summary.name ?? null,
      activeVaultCanWrite: active?.summary.canWrite ?? false,
      isUnlocked: unlocked,
      itemCount: unlocked ? this.cachedItems.size : 0,
      unlockedAtMs: unlocked ? this.unlockedAtMs : null
    };
  }

  async listVaults(): Promise<VaultSummary[]> {
    const { client } = await this.ensureAuthenticatedClient();
    const ownedHeaders = await client.listVaults();
    const nextVaults = new Map<string, VaultEntry>();

    for (const header of ownedHeaders) {
      if (!("Active" in header.state)) continue;
      const idHex = bytesToHex(header.id);
      nextVaults.set(idHex, {
        header,
        summary: {
          idHex,
          name: defaultVaultName(header),
          role: "Owner",
          isOwned: true,
          canWrite: true
        }
      });
    }

    // Also include shared vaults where the caller is an Editor or Viewer.
    try {
      let after = new Uint8Array();
      for (let pageCount = 0; pageCount < 20; pageCount++) {
        const page = await client.listAccessibleVaults(after);
        for (const access of page.entries) {
          if (!("Active" in access.header.state)) continue;
          const idHex = bytesToHex(access.header.id);
          if (nextVaults.has(idHex)) continue;
          const role = mapRole(access.role);
          nextVaults.set(idHex, {
            header: access.header,
            summary: {
              idHex,
              name: defaultVaultName(access.header),
              role,
              isOwned: role === "Owner",
              canWrite: role === "Owner" || role === "Editor"
            }
          });
        }
        if (!page.next[0] || page.next[0].length === 0) break;
        after = bytes(page.next[0]);
      }
    } catch {
      // Fall back gracefully if shared-vault listing is unavailable.
    }

    this.vaults = nextVaults;
    if (this.activeVaultIdHex && !this.vaults.has(this.activeVaultIdHex)) {
      this.activeVaultIdHex = null;
      this.clearUnlockedState();
    }
    return [...this.vaults.values()].map((entry) => entry.summary);
  }

  async createVault(): Promise<VaultSummary> {
    const { client } = await this.ensureAuthenticatedClient();
    try {
      if (typeof client.actor?.initialize_vault_account === "function") {
        await client.actor.initialize_vault_account();
      }
    } catch {
      // Account may already be initialized; proceed to create_vault.
    }
    const header = await client.create();
    const idHex = bytesToHex(header.id);
    const summary: VaultSummary = {
      idHex,
      name: defaultVaultName(header),
      role: "Owner",
      isOwned: true,
      canWrite: true
    };
    this.vaults.set(idHex, { header, summary });
    await this.unlockVault(idHex);
    return summary;
  }

  async unlockVault(requestedVaultIdHex?: string): Promise<VaultEngineState> {
    const { client } = await this.ensureAuthenticatedClient();
    if (this.vaults.size === 0 || (requestedVaultIdHex && !this.vaults.has(requestedVaultIdHex))) {
      await this.listVaults();
    }
    const targetId =
      (requestedVaultIdHex && this.vaults.has(requestedVaultIdHex)
        ? requestedVaultIdHex
        : null) ??
      (this.activeVaultIdHex && this.vaults.has(this.activeVaultIdHex)
        ? this.activeVaultIdHex
        : null) ??
      this.vaults.keys().next().value ??
      null;

    if (!targetId) {
      throw new Error("NO_VAULT");
    }
    const target = this.vaults.get(targetId)!;
    if (target.summary.isOwned) {
      await client.open(target.header);
    } else {
      await client.openAccess(bytes(target.header.id));
    }
    this.activeVaultIdHex = targetId;
    this.unlockedAtMs = this.deps.now();
    await this.refreshItems();
    return this.getState();
  }

  async refreshItems(): Promise<VaultItemSummary[]> {
    const { client } = this.requireUnlockedVault();
    const items = await client.items({ includeDeleted: false });
    const nextMap = new Map<string, Item>();
    for (const item of items) {
      if (item.revision.deleted) continue;
      nextMap.set(bytesToHex(item.revision.object), item);
    }
    this.cachedItems = nextMap;
    return [...this.cachedItems.values()].map((item) => this.toItemSummary(item));
  }

  lockVault(): VaultEngineState {
    if (this.client) {
      this.client.session.lock();
    }
    this.clearUnlockedState();
    const active = this.activeVaultIdHex
      ? this.vaults.get(this.activeVaultIdHex) ?? null
      : null;
    return {
      isAuthenticated: Boolean(this.principal),
      principal: this.principal,
      vaults: [...this.vaults.values()].map((entry) => entry.summary),
      activeVaultIdHex: active?.summary.idHex ?? null,
      activeVaultName: active?.summary.name ?? null,
      activeVaultCanWrite: active?.summary.canWrite ?? false,
      isUnlocked: false,
      itemCount: 0,
      unlockedAtMs: null
    };
  }

  async reloadAuthSession(): Promise<{ reloaded: boolean }> {
    this.destroyClient();
    await this.deps.resetAuthClient();
    return { reloaded: true };
  }

  async forgetAndReset(): Promise<{ reset: boolean }> {
    const existing = this.client;
    if (existing) {
      try {
        await existing.forgetDeviceKeys();
      } catch {
        // Proceed with full teardown even if IndexedDB was unavailable.
      }
    }
    this.destroyClient();
    try {
      await this.deps.clearPersistedDeviceKeys();
    } catch {
      // Continue resetting auth client even if storage wipe fails.
    }
    await this.deps.resetAuthClient();
    return { reset: true };
  }

  listItems(options: {
    url?: string;
    query?: string;
    filter?: ItemCategoryFilter;
  } = {}): {
    matches: VaultItemSummary[];
    items: VaultItemSummary[];
    domain: string | null;
  } {
    this.requireUnlockedVault();
    const domain = options.url ? normalizeDomain(options.url) : null;
    const query = options.query?.trim() ?? "";
    const filter: ItemCategoryFilter = options.filter ?? "all";

    const allSummaries = [...this.cachedItems.values()].map((item) =>
      this.toItemSummary(item)
    );

    const matches: VaultItemSummary[] = domain
      ? allSummaries
          .filter(
            (item) =>
              item.kind === "credential" && matchesDomain(item.domains, domain)
          )
          .sort((a, b) => {
            const scoreDiff =
              domainMatchScore(b.domains, domain) -
              domainMatchScore(a.domains, domain);
            if (scoreDiff !== 0) return scoreDiff;
            if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
            return a.title.localeCompare(b.title);
          })
      : [];

    const filtered = allSummaries
      .filter((summary) => {
        if (filter === "logins" && summary.kind !== "credential") return false;
        if (filter === "notes" && summary.kind !== "note") return false;
        if (filter === "favorites" && !summary.favorite) return false;
        if (!query) return true;
        const raw = this.cachedItems.get(summary.objectIdHex);
        return raw ? matchesMetadataQuery(raw.metadata, query) : false;
      })
      .sort((a, b) => {
        if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
        return a.title.localeCompare(b.title);
      });

    return { matches, items: filtered, domain };
  }

  getMatchesForUrl(url: string): {
    unlocked: boolean;
    domain: string | null;
    matches: VaultItemSummary[];
  } {
    if (!this.isVaultCurrentlyUnlocked()) {
      return {
        unlocked: false,
        domain: normalizeDomain(url),
        matches: []
      };
    }
    const { matches, domain } = this.listItems({ url });
    return { unlocked: true, domain, matches };
  }

  private async readLoginCandidates(url: string) {
    const { client } = this.requireUnlockedVault();
    const ticket = client.session.capture();
    const { items, matches } = this.listItems({ url, filter: "logins" });
    const indexed = new Set(matches.map(item => item.objectIdHex));
    const candidates = matches.concat(items.filter(item => !indexed.has(item.objectIdHex) &&
      (item.domains.length === 0 || item.domains.length >= MAX_CREDENTIAL_DOMAINS)));
    const readable: DecryptedItemView[] = [];
    for (let start = 0; start < candidates.length; start += 4) {
      const batch = candidates.slice(start, start + 4);
      const results = await Promise.allSettled(batch.map(item => this.readItem(item.objectIdHex)));
      client.session.check(ticket);
      for (const result of results) {
        if (result.status === "fulfilled" && result.value.summary.kind === "credential") {
          readable.push(result.value);
        }
      }
    }
    return readable;
  }

  async getLoginMatchesForUrl(url: string) {
    const unlocked = this.isVaultCurrentlyUnlocked();
    const domain = normalizeDomain(url);
    const matches: VaultLoginMatch[] = [];
    if (!unlocked || !domain) return { unlocked, domain, matches };
    for (const view of await this.readLoginCandidates(url)) {
      for (const [loginIndex, login] of credentialLogins(parseCredential(view.rawText)).entries()) {
        const domains = extractDomains(login.urls);
        if (login.password && matchesDomain(domains, domain)) {
          matches.push({
            ...view.summary, loginIndex, username: login.username, domains, hasTotp: Boolean(login.totp)
          });
        }
      }
    }
    return { unlocked, domain, matches };
  }

  async readLoginForUrl(target: VaultLoginTarget, url: string) {
    const { client } = this.requireUnlockedVault();
    const ticket = client.session.capture();
    const item = this.cachedItems.get(target.objectIdHex);
    if (!item || item.revision.revision.toString() !== target.revision) {
      throw new Error("ITEM_CHANGED");
    }
    const view = await this.readItem(target.objectIdHex);
    client.session.check(ticket);
    const current = this.cachedItems.get(target.objectIdHex);
    if (!current || current.revision.revision !== item.revision.revision ||
        bytesToHex(current.revision.vault) !== view.summary.vaultIdHex) {
      throw new Error("ITEM_CHANGED");
    }
    const login = credentialLogins(parseCredential(view.rawText))[target.loginIndex];
    if (view.summary.kind !== "credential" || view.summary.revision !== target.revision ||
        !login?.password || !matchesDomain(login.urls, url)) {
      throw new Error("CREDENTIAL_DOMAIN_MISMATCH");
    }
    return { username: login.username, password: login.password, totp: target.loginIndex === 0 ? view.totp : null };
  }

  async readItem(objectIdHex: string): Promise<DecryptedItemView> {
    const { client } = this.requireUnlockedVault();
    const item = this.cachedItems.get(objectIdHex);
    if (!item) {
      throw new Error("ITEM_NOT_FOUND");
    }
    const ticket = client.session.capture();
    const doc = await client.read(item.revision);
    let rawText = "";
    try {
      client.session.check(ticket);
      rawText = new TextDecoder().decode(doc.plaintext);
    } finally {
      doc.plaintext.fill(0);
    }

    const summary = this.toItemSummary(item);
    if (item.metadata.kind !== "credential") {
      return {
        summary,
        label: item.metadata.title,
        username: "",
        password: "",
        url: "",
        urls: [],
        totpSecret: "",
        totp: null,
        notes: rawText,
        customFields: [],
        favorite: Boolean(item.metadata.favorite),
        tags: item.metadata.tags ? [...item.metadata.tags] : [],
        rawText
      };
    }

    const record = parseCredential(rawText);
    let totp: LiveTotpView | null = null;
    if (record.totp.trim()) {
      try {
        const generated = await generateTotp(record.totp, this.deps.now());
        totp = {
          code: generated.code,
          formattedCode: formatTotpCode(generated.code),
          remainingSeconds: generated.remainingSeconds,
          period: generated.period
        };
      } catch {
        totp = null;
      }
    }

    client.session.check(ticket);
    return {
      summary,
      label: record.label || item.metadata.title,
      username: record.username,
      password: record.password,
      url: record.URL,
      urls: record.urls,
      totpSecret: record.totp,
      totp,
      notes: record.notes,
      customFields: record.customFields,
      favorite: record.favorite,
      tags: record.tags,
      rawText
    };
  }

  async saveCredential(input: SaveCredentialInput): Promise<VaultItemSummary> {
    const { client, vault } = this.requireUnlockedVault();
    if (!vault.summary.canWrite) {
      throw new Error("READ_ONLY_VAULT");
    }
    const existing = input.objectIdHex
      ? this.cachedItems.get(input.objectIdHex)
      : undefined;
    if (input.objectIdHex && !existing) {
      throw new Error("ITEM_NOT_FOUND");
    }

    if (existing && existing.metadata.kind !== "credential") {
      throw new Error("ITEM_NOT_CREDENTIAL");
    }
    if (input.expectedRevision !== undefined &&
        existing?.revision.revision.toString() !== input.expectedRevision) {
      throw new Error("ITEM_CHANGED");
    }
    const ticket = client.session.capture();
    const existingRecord = input.objectIdHex
      ? parseCredential((await this.readItem(input.objectIdHex)).rawText)
      : undefined;
    client.session.check(ticket);

    const title =
      input.title.trim() ||
      normalizeDomain(input.url) ||
      input.username.trim() ||
      "Untitled Login";

    let record = {
      label: title,
      username: input.username,
      password: input.password,
      URL: input.url.trim(),
      urls: input.urls ?? (input.url.trim() ? [input.url.trim()] : []),
      totp: input.totp?.trim() ?? "",
      notes: input.notes ?? "",
      additionalLogins: existingRecord?.additionalLogins,
      customFields: input.customFields ?? [],
      favorite: Boolean(input.favorite),
      tags: input.tags ?? []
    };

    if (input.loginIndex !== undefined && input.loginIndex !== 0) {
      const index = input.loginIndex - 1;
      const login = existingRecord?.additionalLogins?.[index];
      if (!existingRecord || !login || !matchesDomain([login.URL], input.submittedUrl ?? input.url)) {
        throw new Error("CREDENTIAL_DOMAIN_MISMATCH");
      }
      record = {
        ...existingRecord,
        label: title,
        additionalLogins: existingRecord.additionalLogins?.map((entry, i) =>
          i === index ? { ...entry, username: input.username, password: input.password } : entry),
      };
    } else if (input.expectedRevision !== undefined &&
               (!existingRecord || !matchesDomain([existingRecord.URL, ...existingRecord.urls], input.submittedUrl ?? input.url))) {
      throw new Error("CREDENTIAL_DOMAIN_MISMATCH");
    }

    const metadata = buildCredentialMetadata(title, record);
    const plaintext = new TextEncoder().encode(serializeCredential(record));
    const revision = await client.save(metadata, plaintext, existing);
    const updatedItem: Item = { revision, metadata };
    this.cachedItems.set(bytesToHex(revision.object), updatedItem);
    return this.toItemSummary(updatedItem);
  }

  async deleteItem(objectIdHex: string): Promise<{ deleted: boolean }> {
    const { client, vault } = this.requireUnlockedVault();
    if (!vault.summary.canWrite) {
      throw new Error("READ_ONLY_VAULT");
    }
    const existing = this.cachedItems.get(objectIdHex);
    if (!existing) {
      throw new Error("ITEM_NOT_FOUND");
    }
    await client.deleteObject(existing.revision);
    this.cachedItems.delete(objectIdHex);
    return { deleted: true };
  }

  async evaluateSubmittedLogin(input: {
    url: string;
    username: string;
    password: string;
    pageTitle?: string;
  }): Promise<
    | { action: "ignore" }
    | {
        action: "create" | "update";
        existingObjectIdHex?: string;
        domain: string;
        title: string;
      }
  > {
    if (!this.isVaultCurrentlyUnlocked()) return { action: "ignore" };
    const active = this.activeVaultIdHex
      ? this.vaults.get(this.activeVaultIdHex)
      : null;
    if (!active?.summary.canWrite) return { action: "ignore" };

    const domain = normalizeDomain(input.url);
    const password = input.password;
    const username = input.username.trim();
    if (!domain || !password) return { action: "ignore" };

    const normalizedUser = username.toLocaleLowerCase();

    // Preserve an exact password match, even when multiple accounts share a username.
    const updates = [];
    for (const decrypted of await this.readLoginCandidates(input.url)) {
      const candidate = decrypted.summary;
      const matching = credentialLogins(parseCredential(decrypted.rawText)).entries();
      for (const [loginIndex, login] of matching) {
        if (!matchesDomain(login.urls, domain) ||
            login.username.trim().toLocaleLowerCase() !== normalizedUser) continue;
        if (login.password === password) return { action: "ignore" };
        updates.push({
          action: "update" as const,
          existingObjectIdHex: candidate.objectIdHex,
          existingRevision: decrypted.summary.revision,
          existingLoginIndex: loginIndex,
          domain,
          title: decrypted.label || candidate.title || domain
        });
      }
    }
    if (updates.length === 1) return updates[0];
    if (updates.length > 1) return { action: "ignore" };

    const cleanPageTitle = input.pageTitle?.trim();
    const title =
      cleanPageTitle && cleanPageTitle.length <= 64 ? cleanPageTitle : domain;
    return {
      action: "create",
      domain,
      title
    };
  }
}
