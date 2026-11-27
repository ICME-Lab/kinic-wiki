import type { Metadata } from "./documents-v3.ts";
import {
  buildCredentialMetadata,
  credentialLogins,
  normalizeTags,
  truncateMetadataText,
  parseCredential,
  serializeCredential,
  type CredentialCustomField,
  type CredentialRecord,
} from "./credential.ts";

export type ImportFormat =
  | "kinic-json"
  | "bitwarden-json"
  | "bitwarden-csv"
  | "1password-csv"
  | "safari-csv"
  | "chrome-csv"
  | "firefox-csv"
  | "generic-csv";

export type ImportedCredentialItem = {
  kind: "credential";
  title: string;
  record: CredentialRecord;
  metadata: Metadata;
  plaintext: string;
};

export type ImportedNoteItem = {
  kind: "note";
  title: string;
  body: string;
  metadata: Metadata;
  plaintext: string;
};

export type ImportedItem = ImportedCredentialItem | ImportedNoteItem;

export type ImportResult = {
  format: ImportFormat;
  items: ImportedItem[];
  skipped: number;
  warnings: string[];
};

export type ExportedVaultItem =
  | {
      kind: "credential";
      title: string;
      record: CredentialRecord;
    }
  | {
      kind: "note";
      title: string;
      body: string;
      favorite?: boolean;
      tags?: string[];
    };

export type VaultExportEnvelope = {
  format: "kinic-vault-export";
  version: 1;
  exportedAt: string;
  skippedAttachments: number;
  items: ExportedVaultItem[];
};

export function parseCsv(rawText: string): string[][] {
  const text = rawText.startsWith("\uFEFF") ? rawText.slice(1) : rawText;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"' && field.length === 0) {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\r") {
      if (text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((entry) => entry.some((cell) => cell.trim().length > 0));
}

function escapeCsvCell(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

export function formatCsv(rows: readonly (readonly string[])[]): string {
  return rows
    .map((row) => row.map((cell) => escapeCsvCell(cell)).join(","))
    .join("\r\n");
}

function makeImportedCredential(
  title: string,
  partial: Partial<CredentialRecord>,
): ImportedCredentialItem {
  const cleanTitle = truncateMetadataText(
    title.trim() ||
      partial.URL?.trim() ||
      partial.urls?.[0]?.trim() ||
      partial.username?.trim() ||
      "Untitled login",
    512,
  );
  const plaintext = serializeCredential({
    ...partial,
    label: cleanTitle,
  });
  const record = parseCredential(plaintext);
  const metadata = buildCredentialMetadata(cleanTitle, record);
  return {
    kind: "credential",
    title: cleanTitle,
    record,
    metadata,
    plaintext,
  };
}

function makeImportedNote(
  title: string,
  body: string,
  options: { favorite?: boolean; tags?: string[] } = {},
): ImportedNoteItem {
  const cleanTitle = truncateMetadataText(title.trim() || "Untitled note", 512);
  const tags = normalizeTags(options.tags ?? []);
  const metadata: Metadata = {
    kind: "note",
    title: cleanTitle,
    ...(options.favorite ? { favorite: true } : {}),
    ...(tags.length > 0 ? { tags } : {}),
  };
  return {
    kind: "note",
    title: cleanTitle,
    body,
    metadata,
    plaintext: body,
  };
}

function parseJsonImport(parsed: unknown): ImportResult {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("UnsupportedJsonFormat");
  }
  const obj = parsed as Record<string, unknown>;
  const warnings: string[] = [];
  const items: ImportedItem[] = [];
  let skipped = 0;

  // Kinic Vault native JSON export
  if (obj.format === "kinic-vault-export" && Array.isArray(obj.items)) {
    for (const raw of obj.items) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        skipped++;
        continue;
      }
      const entry = raw as Record<string, unknown>;
      if (entry.kind === "credential") {
        const rec =
          entry.record && typeof entry.record === "object"
            ? (entry.record as Partial<CredentialRecord>)
            : {};
        items.push(
          makeImportedCredential(
            typeof entry.title === "string" ? entry.title : rec.label ?? "",
            rec,
          ),
        );
      } else if (entry.kind === "note") {
        items.push(
          makeImportedNote(
            typeof entry.title === "string" ? entry.title : "",
            typeof entry.body === "string" ? entry.body : "",
            {
              favorite: entry.favorite === true,
              tags: Array.isArray(entry.tags)
                ? entry.tags.filter((t): t is string => typeof t === "string")
                : [],
            },
          ),
        );
      } else {
        skipped++;
      }
    }
    return { format: "kinic-json", items, skipped, warnings };
  }

  // Bitwarden JSON export ({ encrypted?: boolean, folders?: [...], items: [...] })
  if (Array.isArray(obj.items)) {
    if (obj.encrypted === true) {
      throw new Error("EncryptedBitwardenJsonUnsupported");
    }
    const folderNames = new Map<string, string>();
    if (Array.isArray(obj.folders)) {
      for (const folder of obj.folders) {
        if (
          folder &&
          typeof folder === "object" &&
          typeof (folder as Record<string, unknown>).id === "string" &&
          typeof (folder as Record<string, unknown>).name === "string"
        ) {
          folderNames.set(
            (folder as Record<string, unknown>).id as string,
            (folder as Record<string, unknown>).name as string,
          );
        }
      }
    }

    for (const raw of obj.items) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        skipped++;
        continue;
      }
      const entry = raw as Record<string, unknown>;
      const name = typeof entry.name === "string" ? entry.name : "";
      const notes = typeof entry.notes === "string" ? entry.notes : "";
      const favorite = entry.favorite === true;
      const folderId =
        typeof entry.folderId === "string" ? entry.folderId : undefined;
      const tags =
        folderId && folderNames.has(folderId)
          ? [folderNames.get(folderId)!]
          : [];
      const customFields: CredentialCustomField[] = Array.isArray(entry.fields)
        ? entry.fields
            .filter(
              (f): f is Record<string, unknown> =>
                !!f && typeof f === "object" && !Array.isArray(f),
            )
            .map((f) => ({
              label: typeof f.name === "string" ? f.name : "",
              value: typeof f.value === "string" ? f.value : "",
              hidden: f.type === 1,
            }))
            .filter((f) => f.label.length > 0 || f.value.length > 0)
        : [];

      if (entry.type === 1) {
        const login =
          entry.login && typeof entry.login === "object"
            ? (entry.login as Record<string, unknown>)
            : {};
        const uris = Array.isArray(login.uris)
          ? login.uris
              .map((u) =>
                u && typeof u === "object"
                  ? (u as Record<string, unknown>).uri
                  : undefined,
              )
              .filter((u): u is string => typeof u === "string" && u.length > 0)
          : [];
        items.push(
          makeImportedCredential(name, {
            username:
              typeof login.username === "string" ? login.username : "",
            password:
              typeof login.password === "string" ? login.password : "",
            URL: uris[0] ?? "",
            urls: uris,
            totp: typeof login.totp === "string" ? login.totp : "",
            notes,
            customFields,
            favorite,
            tags,
          }),
        );
      } else if (entry.type === 2) {
        const extra = customFields.length
          ? `\n\n${customFields.map((f) => `${f.label}: ${f.value}`).join("\n")}`
          : "";
        items.push(
          makeImportedNote(name, `${notes}${extra}`.trim(), {
            favorite,
            tags,
          }),
        );
      } else {
        skipped++;
      }
    }
    if (skipped > 0) {
      warnings.push(
        `Skipped ${skipped} unsupported Bitwarden item(s) (such as cards or identities).`,
      );
    }
    return { format: "bitwarden-json", items, skipped, warnings };
  }

  throw new Error("UnsupportedJsonFormat");
}

function headerIndex(headers: string[], candidates: string[]): number {
  for (const name of candidates) {
    const idx = headers.indexOf(name);
    if (idx !== -1) return idx;
  }
  return -1;
}

function parseCsvImport(text: string): ImportResult {
  const rows = parseCsv(text);
  if (rows.length < 2) {
    return { format: "generic-csv", items: [], skipped: 0, warnings: [] };
  }

  const headers = rows[0].map((h) => h.trim().toLowerCase());
  const has = (name: string) => headers.includes(name);

  let format: ImportFormat = "generic-csv";
  if (has("login_username") || has("login_password") || has("login_uri")) {
    format = "bitwarden-csv";
  } else if (has("otpauth") && has("title") && has("url")) {
    format = has("tags") ? "1password-csv" : "safari-csv";
  } else if (has("one-time password") || has("website")) {
    format = "1password-csv";
  } else if (has("httpRealm".toLowerCase()) || has("formactionorigin")) {
    format = "firefox-csv";
  } else if (has("name") && has("url") && has("username") && has("password")) {
    format = "chrome-csv";
  }

  const iType = headerIndex(headers, ["type"]);
  const iTitle = headerIndex(headers, ["title", "name", "label"]);
  const iUrl = headerIndex(headers, [
    "login_uri",
    "url",
    "website",
    "urls",
    "origin",
  ]);
  const iUsername = headerIndex(headers, [
    "login_username",
    "username",
    "user",
    "email",
  ]);
  const iPassword = headerIndex(headers, ["login_password", "password"]);
  const iTotp = headerIndex(headers, [
    "login_totp",
    "otpauth",
    "one-time password",
    "totp",
    "otp",
  ]);
  const iNotes = headerIndex(headers, ["notes", "note"]);
  const iFolder = headerIndex(headers, ["folder", "tags", "tag"]);
  const iFavorite = headerIndex(headers, ["favorite"]);

  if (iPassword === -1 && iUsername === -1 && iNotes === -1) {
    throw new Error("UnsupportedCsvHeaders");
  }

  const items: ImportedItem[] = [];
  const warnings: string[] = [];
  let skipped = 0;

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const get = (idx: number) => (idx >= 0 && idx < row.length ? row[idx] : "");
    const type = get(iType).trim().toLowerCase();
    const title = get(iTitle).trim();
    const rawUrl = get(iUrl).trim();
    const username = get(iUsername).trim();
    const password = get(iPassword);
    const totp = get(iTotp).trim();
    const notes = get(iNotes);
    const rawTags = get(iFolder).trim();
    const tags = rawTags
      ? normalizeTags(rawTags.split(/[;,]/))
      : [];
    const favRaw = get(iFavorite).trim().toLowerCase();
    const favorite = favRaw === "1" || favRaw === "true" || favRaw === "yes";

    if (type === "note" || type === "secure note") {
      if (!title && !notes.trim()) {
        skipped++;
        continue;
      }
      items.push(makeImportedNote(title, notes, { favorite, tags }));
      continue;
    }

    if (type && type !== "login" && type !== "password") {
      skipped++;
      continue;
    }

    if (!title && !rawUrl && !username && !password && !notes.trim()) {
      skipped++;
      continue;
    }

    const urls = rawUrl
      ? rawUrl
          .split(/[\n\s]+/)
          .map((u) => u.trim())
          .filter(Boolean)
      : [];

    items.push(
      makeImportedCredential(title, {
        username,
        password,
        URL: urls[0] ?? rawUrl,
        urls,
        totp,
        notes,
        favorite,
        tags,
      }),
    );
  }

  if (skipped > 0) {
    warnings.push(`Skipped ${skipped} empty or unsupported row(s).`);
  }

  return { format, items, skipped, warnings };
}

export function parseImportFile(
  content: string,
  filename = "",
): ImportResult {
  const trimmed = content.trim();
  if (!trimmed) {
    return { format: "generic-csv", items: [], skipped: 0, warnings: [] };
  }
  const looksJson =
    filename.toLowerCase().endsWith(".json") ||
    trimmed.startsWith("{") ||
    trimmed.startsWith("[");
  if (looksJson) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      if (filename.toLowerCase().endsWith(".json")) {
        throw new Error("InvalidJsonFile");
      }
      return parseCsvImport(content);
    }
    return parseJsonImport(parsed);
  }
  return parseCsvImport(content);
}

export function exportVaultToJson(
  items: readonly ExportedVaultItem[],
  skippedAttachments = 0,
  now: Date = new Date(),
): string {
  const envelope: VaultExportEnvelope = {
    format: "kinic-vault-export",
    version: 1,
    exportedAt: now.toISOString(),
    skippedAttachments,
    items: [...items],
  };
  return JSON.stringify(envelope, null, 2);
}

export function exportCredentialsToCsv(
  items: readonly ExportedVaultItem[],
): string {
  const rows: string[][] = [
    ["Title", "URL", "Username", "Password", "OTPAuth", "Notes", "Tags", "Favorite"],
  ];
  for (const item of items) {
    if (item.kind !== "credential") continue;
    const rec = item.record;
    for (const login of credentialLogins(rec)) {
      rows.push([
        item.title,
        login.URL || login.urls.find(Boolean) || "",
        login.username,
        login.password,
        login.totp,
        rec.notes,
        rec.tags.join(", "),
        rec.favorite ? "true" : "",
      ]);
    }
  }
  return formatCsv(rows);
}
