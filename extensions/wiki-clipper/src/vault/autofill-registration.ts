// Where: extensions/wiki-clipper/src/vault/autofill-registration.ts
// What: Registers the Vault autofill content script only for origins the user granted.
// Why: Website access is an optional permission, so Wiki Clipper users who never turn on
//      Vault autofill are not asked to let the extension read every site.

export const AUTOFILL_ORIGINS = [
  "https://*/*",
  "http://localhost/*",
  "http://127.0.0.1/*"
] as const;

export const AUTOFILL_SCRIPT_ID = "kinic-vault-autofill";
export const AUTOFILL_SCRIPT_FILE = "dist/content-autofill.js";

export type AutofillChromeApi = {
  permissions: {
    contains(permissions: { origins: string[] }): Promise<boolean>;
  };
  scripting: {
    getRegisteredContentScripts(filter: { ids: string[] }): Promise<Array<{ id: string; matches?: string[] }>>;
    registerContentScripts(scripts: Array<Record<string, unknown>>): Promise<void>;
    updateContentScripts(scripts: Array<Record<string, unknown>>): Promise<void>;
    unregisterContentScripts(filter: { ids: string[] }): Promise<void>;
  };
};

/** Origins from AUTOFILL_ORIGINS that the user has currently granted. */
export async function grantedAutofillOrigins(api: AutofillChromeApi): Promise<string[]> {
  const granted: string[] = [];
  for (const origin of AUTOFILL_ORIGINS) {
    if (await api.permissions.contains({ origins: [origin] })) granted.push(origin);
  }
  return granted;
}

/**
 * Makes the registered autofill script match exactly the granted origins.
 * Returns the origins it now runs on (empty when website access is off).
 */
export async function syncAutofillRegistration(api: AutofillChromeApi): Promise<string[]> {
  const matches = await grantedAutofillOrigins(api);
  const existing = await api.scripting.getRegisteredContentScripts({ ids: [AUTOFILL_SCRIPT_ID] });
  if (matches.length === 0) {
    if (existing.length > 0) {
      await api.scripting.unregisterContentScripts({ ids: [AUTOFILL_SCRIPT_ID] });
    }
    return matches;
  }
  const script = {
    id: AUTOFILL_SCRIPT_ID,
    matches,
    js: [AUTOFILL_SCRIPT_FILE],
    runAt: "document_idle",
    allFrames: false,
    persistAcrossSessions: true
  };
  if (existing.length === 0) {
    await api.scripting.registerContentScripts([script]);
  } else if ((existing[0].matches ?? []).join("\n") !== matches.join("\n")) {
    await api.scripting.updateContentScripts([script]);
  }
  return matches;
}
