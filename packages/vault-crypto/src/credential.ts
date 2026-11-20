import type { Metadata } from "./documents-v3.ts";

export type CredentialCustomField = {
  label: string;
  value: string;
  hidden?: boolean;
};

export type CredentialRecord = {
  label: string;
  username: string;
  password: string;
  URL: string;
  urls: string[];
  totp: string;
  notes: string;
  customFields: CredentialCustomField[];
  favorite: boolean;
  tags: string[];
};

const MAX_DOMAINS = 32;
const MAX_TAGS = 32;
const MAX_TAG_LENGTH = 64;
const MAX_USERNAME_META_LENGTH = 256;

const BLOCKED_SCHEMES = new Set([
  "javascript",
  "data",
  "vbscript",
  "blob",
  "file",
  "about",
  "mailto",
  "tel",
]);

function dedupeStrings(values: readonly string[], maxItems: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= maxItems) break;
  }
  return out;
}

export function normalizeDomain(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2048) return null;

  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(trimmed);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    if (BLOCKED_SCHEMES.has(scheme)) return null;
    if (scheme !== "http" && scheme !== "https" && scheme !== "android") {
      // Allow custom app URI schemes only if they contain //host
      if (!trimmed.includes("://")) return null;
    }
  }

  let candidate = trimmed;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(candidate)) {
    // Reject strings containing whitespace when no scheme is present.
    if (/\s/.test(candidate)) return null;
    candidate = `https://${candidate}`;
  }

  try {
    const parsed = new URL(candidate);
    let host = parsed.hostname.toLowerCase();
    if (host.endsWith(".")) host = host.slice(0, -1);
    if (!host || host.length > 255) return null;
    if (host.startsWith("[") && host.endsWith("]")) {
      return host;
    }
    // Require a dot, localhost, or IPv4-like host so random words do not index as domains.
    if (
      host !== "localhost" &&
      !host.includes(".") &&
      !/^\d+$/.test(host)
    ) {
      return null;
    }
    return host;
  } catch {
    return null;
  }
}

export function extractDomains(urls: readonly string[]): string[] {
  const seen = new Set<string>();
  const domains: string[] = [];
  for (const url of urls) {
    const domain = normalizeDomain(url);
    if (!domain || seen.has(domain)) continue;
    seen.add(domain);
    domains.push(domain);
    if (domains.length >= MAX_DOMAINS) break;
  }
  return domains;
}

export function matchesDomain(
  domains: readonly string[] | undefined,
  queryHost: string,
): boolean {
  const target = normalizeDomain(queryHost);
  if (!target || !domains?.length) return false;
  return domains.some((entry) => {
    const domain = entry.toLowerCase();
    return (
      domain === target ||
      target.endsWith(`.${domain}`) ||
      domain.endsWith(`.${target}`)
    );
  });
}

export function truncateMetadataText(text: string, limit: number): string {
  // Unicode matching preserves pairs and removes any lone surrogate at the boundary.
  return text.slice(0, limit).replace(/[\uD800-\uDFFF]/gu, "");
}

export function normalizeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const trimmed = truncateMetadataText(raw.trim(), MAX_TAG_LENGTH);
    if (!trimmed) continue;
    const key = trimmed.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

export function parseTagsInput(raw: string): string[] {
  return normalizeTags(raw.split(","));
}

export function parseCredential(text: string): CredentialRecord {
  const empty: CredentialRecord = {
    label: "",
    username: "",
    password: "",
    URL: "",
    urls: [],
    totp: "",
    notes: "",
    customFields: [],
    favorite: false,
    tags: [],
  };
  const trimmed = text.trim();
  if (!trimmed) return empty;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ...empty, notes: text };
    }
    const obj = parsed as Record<string, unknown>;
    const primaryUrl =
      typeof obj.URL === "string"
        ? obj.URL
        : typeof obj.url === "string"
          ? obj.url
          : "";
    const extraUrls = Array.isArray(obj.urls)
      ? obj.urls.filter((entry): entry is string => typeof entry === "string")
      : [];
    const urls = dedupeStrings(
      [primaryUrl, ...extraUrls].filter((entry) => entry.trim().length > 0),
      MAX_DOMAINS,
    );
    const customFields: CredentialCustomField[] = Array.isArray(
      obj.customFields,
    )
      ? obj.customFields
          .filter(
            (field): field is Record<string, unknown> =>
              !!field && typeof field === "object" && !Array.isArray(field),
          )
          .map((field) => ({
            label: typeof field.label === "string" ? field.label : "",
            value: typeof field.value === "string" ? field.value : "",
            ...(typeof field.hidden === "boolean"
              ? { hidden: field.hidden }
              : {}),
          }))
          .filter((field) => field.label.length > 0 || field.value.length > 0)
      : [];
    const tags = Array.isArray(obj.tags)
      ? normalizeTags(
          obj.tags.filter((tag): tag is string => typeof tag === "string"),
        )
      : [];
    return {
      label: typeof obj.label === "string" ? obj.label : "",
      username: typeof obj.username === "string" ? obj.username : "",
      password: typeof obj.password === "string" ? obj.password : "",
      URL: primaryUrl || urls[0] || "",
      urls,
      totp: typeof obj.totp === "string" ? obj.totp : "",
      notes: typeof obj.notes === "string" ? obj.notes : "",
      customFields,
      favorite: obj.favorite === true,
      tags,
    };
  } catch {
    return { ...empty, notes: text };
  }
}

export function serializeCredential(
  input: Partial<CredentialRecord> & {
    label?: string;
    username?: string;
    password?: string;
    URL?: string;
    notes?: string;
  },
): string {
  const rawUrls = [
    ...(typeof input.URL === "string" ? [input.URL] : []),
    ...(input.urls ?? []),
  ];
  const urls = dedupeStrings(rawUrls, MAX_DOMAINS);
  const primaryUrl = typeof input.URL === "string" && input.URL.trim()
    ? input.URL.trim()
    : urls[0] ?? "";
  const totp = typeof input.totp === "string" ? input.totp.trim() : "";
  const tags = normalizeTags(input.tags ?? []);
  const customFields = (input.customFields ?? []).filter(
    (field) => field.label.trim().length > 0 || field.value.length > 0,
  );

  const payload: Record<string, unknown> = {
    label: input.label ?? "",
    username: input.username ?? "",
    password: input.password ?? "",
    URL: primaryUrl,
    notes: input.notes ?? "",
  };
  if (urls.length > 1 || (urls.length === 1 && urls[0] !== primaryUrl)) {
    payload.urls = urls;
  }
  if (totp) payload.totp = totp;
  if (customFields.length > 0) payload.customFields = customFields;
  if (input.favorite) payload.favorite = true;
  if (tags.length > 0) payload.tags = tags;

  return JSON.stringify(payload);
}

export function buildCredentialMetadata(
  title: string,
  record: Partial<CredentialRecord>,
): Metadata {
  const urls = [
    ...(typeof record.URL === "string" ? [record.URL] : []),
    ...(record.urls ?? []),
  ];
  const domains = extractDomains(urls);
  const username = truncateMetadataText((record.username ?? "").trim(), MAX_USERNAME_META_LENGTH);
  const hasTotp = Boolean(record.totp && record.totp.trim().length > 0);
  const tags = normalizeTags(record.tags ?? []);

  const metadata: Metadata = {
    kind: "credential",
    title: truncateMetadataText(title, 512),
  };
  if (username) metadata.username = username;
  if (domains.length > 0) metadata.domains = domains;
  if (hasTotp) metadata.hasTotp = true;
  if (record.favorite) metadata.favorite = true;
  if (tags.length > 0) metadata.tags = tags;
  return metadata;
}

export function matchesMetadataQuery(
  metadata: Metadata,
  rawQuery: string,
): boolean {
  const query = rawQuery.trim().toLocaleLowerCase();
  if (!query) return true;
  if (metadata.title.toLocaleLowerCase().includes(query)) return true;
  if (metadata.username?.toLocaleLowerCase().includes(query)) return true;
  if (
    metadata.domains?.some((domain) =>
      domain.toLocaleLowerCase().includes(query),
    )
  ) {
    return true;
  }
  if (
    metadata.tags?.some((tag) => tag.toLocaleLowerCase().includes(query))
  ) {
    return true;
  }
  return false;
}
