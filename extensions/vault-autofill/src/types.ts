// Where: extensions/vault-autofill/src/types.ts
// What: Shared type definitions for Kinic Vault Chrome extension messaging and UI state.
// Why: Keep popup, service worker, offscreen engine, and content scripts strongly typed.
import type { CredentialCustomField } from "@kinic/vault-crypto/credential";

export type VaultSummary = {
  idHex: string;
  name: string;
  role: "Owner" | "Editor" | "Viewer";
  isOwned: boolean;
  canWrite: boolean;
};

export type VaultItemSummary = {
  objectIdHex: string;
  vaultIdHex: string;
  revision: string;
  kind: "credential" | "note" | "attachment";
  title: string;
  username: string;
  domains: string[];
  hasTotp: boolean;
  favorite: boolean;
  tags: string[];
  updatedAtMs: number;
};

export type LiveTotpView = {
  code: string;
  formattedCode: string;
  remainingSeconds: number;
  period: number;
};

export type DecryptedItemView = {
  summary: VaultItemSummary;
  label: string;
  username: string;
  password: string;
  url: string;
  urls: string[];
  totpSecret: string;
  totp: LiveTotpView | null;
  notes: string;
  customFields: CredentialCustomField[];
  favorite: boolean;
  tags: string[];
  rawText: string;
};

export type VaultEngineState = {
  isAuthenticated: boolean;
  principal: string | null;
  vaults: VaultSummary[];
  activeVaultIdHex: string | null;
  activeVaultName: string | null;
  activeVaultCanWrite: boolean;
  isUnlocked: boolean;
  itemCount: number;
  unlockedAtMs: number | null;
};

export type SaveCredentialInput = {
  objectIdHex?: string;
  title: string;
  username: string;
  password: string;
  url: string;
  urls?: string[];
  totp?: string;
  notes?: string;
  customFields?: CredentialCustomField[];
  favorite?: boolean;
  tags?: string[];
};

export type PendingSavePrompt = {
  id: string;
  tabId: number;
  mode: "create" | "update";
  existingObjectIdHex?: string;
  domain: string;
  url: string;
  title: string;
  username: string;
  password: string;
  createdAtMs: number;
};

export type VaultExtensionSettings = {
  selectedVaultIdHex: string;
  autoLockMinutes: number;
  inlineTriggerEnabled: boolean;
  saveBannerEnabled: boolean;
};

export const DEFAULT_EXTENSION_SETTINGS: VaultExtensionSettings = {
  selectedVaultIdHex: "",
  autoLockMinutes: 30,
  inlineTriggerEnabled: true,
  saveBannerEnabled: true
};

export type ItemCategoryFilter = "all" | "logins" | "favorites" | "notes";
