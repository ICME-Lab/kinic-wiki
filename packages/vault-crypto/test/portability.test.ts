import { describe, expect, it } from "vitest";
import {
  exportCredentialsToCsv,
  exportVaultToJson,
  parseCsv,
  parseImportFile,
} from "../src/portability.ts";

describe("vault import and bulk export portability", () => {
  it("parses RFC 4180 CSV with BOM, quoted commas, escaped quotes, and multiline notes", () => {
    const csv =
      '\uFEFFname,url,username,password,note\r\n"GitHub, Inc.",https://github.com/login,alice,"p""ass","line 1\nline 2"';
    const rows = parseCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual([
      "GitHub, Inc.",
      "https://github.com/login",
      "alice",
      'p"ass',
      "line 1\nline 2",
    ]);

    const imported = parseImportFile(csv, "chrome-passwords.csv");
    expect(imported.format).toBe("chrome-csv");
    expect(imported.items).toHaveLength(1);
    const first = imported.items[0];
    expect(first.kind).toBe("credential");
    if (first.kind === "credential") {
      expect(first.title).toBe("GitHub, Inc.");
      expect(first.record.password).toBe('p"ass');
      expect(first.record.notes).toBe("line 1\nline 2");
      expect(first.metadata.domains).toEqual(["github.com"]);
      expect(first.metadata.username).toBe("alice");
    }
  });

  it("imports Safari / 1Password CSV with OTPAuth", () => {
    const csv = [
      "Title,URL,Username,Password,Notes,OTPAuth",
      "AWS,https://console.aws.amazon.com,root@example.com,pw123,prod,otpauth://totp/AWS?secret=JBSWY3DPEHPK3PXP",
    ].join("\n");
    const imported = parseImportFile(csv, "passwords.csv");
    expect(imported.format).toBe("safari-csv");
    expect(imported.items).toHaveLength(1);
    const item = imported.items[0];
    expect(item.kind).toBe("credential");
    if (item.kind === "credential") {
      expect(item.metadata.hasTotp).toBe(true);
      expect(item.metadata.domains).toEqual(["console.aws.amazon.com"]);
    }
  });

  it("imports Bitwarden JSON including logins, secure notes, folders, and custom fields", () => {
    const json = JSON.stringify({
      encrypted: false,
      folders: [{ id: "f1", name: "Work" }],
      items: [
        {
          type: 1,
          name: "Cloudflare",
          folderId: "f1",
          favorite: true,
          notes: "DNS account",
          fields: [{ name: "Account ID", value: "abc", type: 0 }],
          login: {
            username: "ops@example.com",
            password: "secret!",
            totp: "JBSWY3DPEHPK3PXP",
            uris: [{ uri: "https://dash.cloudflare.com" }],
          },
        },
        {
          type: 2,
          name: "Server Runbook",
          notes: "# SSH instructions",
        },
        {
          type: 3,
          name: "Credit Card",
        },
      ],
    });
    const imported = parseImportFile(json, "bitwarden_export.json");
    expect(imported.format).toBe("bitwarden-json");
    expect(imported.items).toHaveLength(2);
    expect(imported.skipped).toBe(1);
    expect(imported.items[0].kind).toBe("credential");
    expect(imported.items[1].kind).toBe("note");
    if (imported.items[0].kind === "credential") {
      expect(imported.items[0].metadata.tags).toEqual(["Work"]);
      expect(imported.items[0].metadata.favorite).toBe(true);
      expect(imported.items[0].record.customFields).toEqual([
        { label: "Account ID", value: "abc", hidden: false },
      ]);
    }
  });

  it("rejects encrypted Bitwarden JSON cleanly", () => {
    expect(() =>
      parseImportFile(JSON.stringify({ encrypted: true, items: [] }), "bw.json"),
    ).toThrow("EncryptedBitwardenJsonUnsupported");
  });

  it("round-trips full Kinic Vault JSON export and standard CSV export", () => {
    const exportedJson = exportVaultToJson(
      [
        {
          kind: "credential",
          title: "Linear",
          record: {
            label: "Linear",
            username: "dev@example.com",
            password: "pw!",
            URL: "https://linear.app",
            urls: ["https://linear.app"],
            totp: "JBSWY3DPEHPK3PXP",
            notes: "Team workspace",
            customFields: [],
            favorite: true,
            tags: ["work"],
          },
        },
        {
          kind: "note",
          title: "Recovery",
          body: "Keep offline",
          favorite: false,
          tags: ["personal"],
        },
      ],
      1,
      new Date("2026-11-19T00:00:00.000Z"),
    );

    const reimported = parseImportFile(exportedJson, "kinic-vault-export.json");
    expect(reimported.format).toBe("kinic-json");
    expect(reimported.items).toHaveLength(2);
    expect(reimported.items[0].metadata.hasTotp).toBe(true);
    expect(reimported.items[1].kind).toBe("note");

    const exportedCsv = exportCredentialsToCsv(
      reimported.items.map((item) =>
        item.kind === "credential"
          ? { kind: "credential", title: item.title, record: item.record }
          : { kind: "note", title: item.title, body: item.body },
      ),
    );
    const reimportedCsv = parseImportFile(exportedCsv, "export.csv");
    expect(reimportedCsv.items).toHaveLength(1);
    expect(reimportedCsv.items[0].title).toBe("Linear");
  });
});

it("exports each additional login as a CSV row and keeps it grouped in JSON", () => {
  const items = [{
    kind: "credential" as const, title: "Accounts",
    record: { label: "Accounts", username: "main", password: "main-password",
      URL: "https://primary.example", urls: [], notes: "", tags: [], favorite: false,
      customFields: [], totp: "JBSWY3DPEHPK3PXP",
      additionalLogins: [
        { username: "other", password: "other-password", URL: "https://secondary.example" },
        { username: "another", password: "another-password", URL: "https://secondary.example" },
      ],
    },
  }];
  const csv = parseImportFile(exportCredentialsToCsv(items), "vault.csv");
  expect(csv.items.map(item => item.kind === "credential" && [item.record.username, item.record.password, item.record.totp])).toEqual([
    ["main", "main-password", "JBSWY3DPEHPK3PXP"],
    ["other", "other-password", ""],
    ["another", "another-password", ""],
  ]);
  const json = parseImportFile(exportVaultToJson(items), "vault.json");
  expect(json.items).toHaveLength(1);
  const first = json.items[0];
  expect(first.kind === "credential" && first.record.additionalLogins).toEqual(items[0].record.additionalLogins);
});
