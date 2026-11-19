import { Principal } from '@icp-sdk/core/principal';
export const CANONICAL_WIKI_ORIGIN = 'https://wiki.kinic.xyz';
export interface BrowserConfig {
  canister: string;
  host: string;
  derivationOrigin: string;
  identityProvider: string;
  origin: string;
  local: boolean;
  wikiOrigin?: string | null;
  fundingMode?: "unavailable" | "synthetic-test-only" | "production";
}
export function validateConfig(c: BrowserConfig, origin: string): BrowserConfig {
  if (c.fundingMode !== undefined && !["unavailable", "synthetic-test-only", "production"].includes(c.fundingMode)) throw Error('InvalidConfiguration');
  const id = Principal.fromText(c.canister).toText();
  const host = new URL(c.host),
    d = new URL(c.derivationOrigin),
    page = new URL(origin),
    provider = new URL(c.identityProvider);
  const localHost = (h: string) => h === 'localhost' || h === '127.0.0.1' || h.endsWith('.localhost');
  if (c.wikiOrigin !== undefined && c.wikiOrigin !== null) {
    const wiki = new URL(c.wikiOrigin);
    const valid = c.local
      ? wiki.origin === c.wikiOrigin && /^https?:$/.test(wiki.protocol) && (localHost(wiki.hostname) || wiki.hostname === '[::1]') && wiki.port !== '0' && wiki.origin !== origin
      : c.wikiOrigin === CANONICAL_WIKI_ORIGIN;
    if (!valid) throw Error('InvalidWikiOrigin');
  }
  if (c.local) {
    if (!localHost(host.hostname) || !localHost(d.hostname) || !localHost(page.hostname) || !localHost(provider.hostname) || c.origin !== origin) throw Error('InvalidLocalConfiguration');
    if (!d.hostname.startsWith(`${id}.`)) throw Error('InvalidDerivationOrigin');
  } else if (c.host !== 'https://icp0.io' || c.derivationOrigin !== `https://${id}.icp0.io` || c.identityProvider !== 'https://id.ai' || c.origin !== 'https://vault.kinic.xyz' || ![c.origin, c.derivationOrigin].includes(origin)) throw Error('InvalidConfiguration');
  return c;
}
export async function loadConfig(): Promise<BrowserConfig> {
  const r = await fetch('/config.json', {
    credentials: 'omit',
    referrerPolicy: 'no-referrer'
  });
  if (!r.ok) throw Error('ConfigurationUnavailable');
  return validateConfig(await r.json(), location.origin);
}
