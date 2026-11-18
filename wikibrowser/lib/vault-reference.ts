const PRODUCTION_VAULT_ORIGIN = "https://vault.kinic.xyz";
const LOCALHOST_SUBDOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+localhost$/;

export function trustedVaultOrigin(wikiOrigin: string): string {
  const configured: unknown = import.meta.env.VITE_LOCAL_VAULT_ORIGIN;
  if (!import.meta.env.DEV || typeof configured !== "string" || configured === wikiOrigin) return PRODUCTION_VAULT_ORIGIN;

  try {
    const url = new URL(configured);
    if (url.origin === configured && (url.protocol === "http:" || url.protocol === "https:")) {
      const host = url.hostname;
      if (host === "localhost" || host === "127.0.0.1" || host === "[::1]" || LOCALHOST_SUBDOMAIN.test(host)) {
        return configured;
      }
    }
  } catch {
    // Ignore malformed development configuration.
  }
  return PRODUCTION_VAULT_ORIGIN;
}

export function isVaultId(value: unknown): value is string {
  return typeof value === "string" && value.length === 32 && /^[0-9a-f]{32}$/.test(value);
}

export function isVaultReferenceUrl(href: unknown, origin: string): href is string {
  const prefix = `${origin}/embed/`;
  if (typeof href !== "string" || !href.startsWith(prefix)) return false;
  const [vault, object, extra] = href.slice(prefix.length).split("/");
  return isVaultId(vault) && isVaultId(object) && extra === undefined;
}

export function vaultReferenceMarkdown(url: string): string {
  return `[非公開資料](${url})`;
}
