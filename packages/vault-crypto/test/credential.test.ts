import { describe, expect, it } from "vitest";
import {
  buildCredentialMetadata,
  extractDomains,
  matchesDomain,
  matchesMetadataQuery,
  normalizeDomain,
  parseCredential,
  parseTagsInput,
  serializeCredential,
} from "../src/credential.ts";

describe("credential schema and domain helpers", () => {
  it("does not write an unpaired surrogate when truncating v3 metadata", () => {
    const tag = "a".repeat(63) + "🗝";
    const title = "b".repeat(511) + "🗝";
    const username = "c".repeat(255) + "🗝";
    const metadata = buildCredentialMetadata(title, { username, tags: [tag] });

    expect(metadata.title).toBe("b".repeat(511));
    expect(metadata.username).toBe("c".repeat(255));
    expect(metadata.tags).toEqual(["a".repeat(63)]);
  });

  it("normalizes valid URLs and bare domains and rejects unsafe schemes", () => {
    expect(normalizeDomain("https://App.GitHub.com:8443/login?next=/")).toBe(
      "app.github.com",
    );
    expect(normalizeDomain("example.co.jp/path")).toBe("example.co.jp");
    expect(normalizeDomain("http://localhost:3000/admin")).toBe("localhost");
    expect(normalizeDomain("javascript:alert(1)")).toBeNull();
    expect(normalizeDomain("data:text/html,foo")).toBeNull();
    expect(normalizeDomain("not a url")).toBeNull();
    expect(normalizeDomain("plainword")).toBeNull();
  });

  it("extracts deduplicated domains and matches subdomains", () => {
    const domains = extractDomains([
      "https://github.com/login",
      "https://gist.github.com/",
      "github.com",
      "invalid",
    ]);
    expect(domains).toEqual(["github.com", "gist.github.com"]);
    expect(matchesDomain(domains, "https://api.github.com/v1")).toBe(true);
    expect(matchesDomain(domains, "https://github.com")).toBe(true);
    expect(matchesDomain(domains, "https://notgithub.com")).toBe(false);
    // Stored subdomain must not match its parent domain or sibling subdomains.
    expect(matchesDomain(["accounts.example.com"], "https://example.com")).toBe(
      false,
    );
    expect(
      matchesDomain(["accounts.example.com"], "https://mail.example.com"),
    ).toBe(false);
    expect(
      matchesDomain(["accounts.example.com"], "https://accounts.example.com"),
    ).toBe(true);
    // Public suffixes and shared multi-tenant hosts must not act as wildcard parents.
    expect(matchesDomain(["co.uk"], "https://bank.co.uk")).toBe(false);
    expect(matchesDomain(["github.io"], "https://victim.github.io")).toBe(false);
    expect(matchesDomain(["icp0.io"], "https://canister.icp0.io")).toBe(false);
    expect(matchesDomain(["127.0.0.1"], "https://127.0.0.1")).toBe(true);
  });

  it("round-trips legacy and extended credential payloads", () => {
    const legacy = parseCredential(
      JSON.stringify({
        label: "Bank",
        username: "alice",
        password: "pw",
        URL: "https://bank.example",
        notes: "pin hint",
      }),
    );
    expect(legacy).toEqual({
      label: "Bank",
      username: "alice",
      password: "pw",
      URL: "https://bank.example",
      urls: ["https://bank.example"],
      totp: "",
      notes: "pin hint",
      customFields: [],
      favorite: false,
      tags: [],
    });

    const serialized = serializeCredential({
      label: "GitHub",
      username: "alice@example.com",
      password: "secret",
      URL: "https://github.com/login",
      urls: ["https://github.com/login", "https://gist.github.com"],
      totp: "otpauth://totp/GitHub:alice?secret=JBSWY3DPEHPK3PXP",
      notes: "recovery codes",
      favorite: true,
      tags: parseTagsInput("work, dev, Work"),
    });
    const reparsed = parseCredential(serialized);
    expect(reparsed.URL).toBe("https://github.com/login");
    expect(reparsed.urls).toEqual([
      "https://github.com/login",
      "https://gist.github.com",
    ]);
    expect(reparsed.totp).toContain("JBSWY3DPEHPK3PXP");
    expect(reparsed.favorite).toBe(true);
    expect(reparsed.tags).toEqual(["work", "dev"]);

    const meta = buildCredentialMetadata("GitHub", reparsed);
    expect(meta).toEqual({
      kind: "credential",
      title: "GitHub",
      username: "alice@example.com",
      domains: ["github.com", "gist.github.com"],
      hasTotp: true,
      favorite: true,
      tags: ["work", "dev"],
    });
    expect(matchesMetadataQuery(meta, "gist.github")).toBe(true);
    expect(matchesMetadataQuery(meta, "alice@")).toBe(true);
    expect(matchesMetadataQuery(meta, "dev")).toBe(true);
    expect(matchesMetadataQuery(meta, "other")).toBe(false);
  });
});
