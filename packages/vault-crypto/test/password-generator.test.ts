import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  estimatePasswordStrength,
  estimatePassphraseStrength,
  generatePassphrase,
  generatePassword,
} from "../src/password-generator.ts";
import { PASSPHRASE_WORDLIST } from "../src/passphrase-wordlist.ts";

describe("password and passphrase generator", () => {
  it("generates passwords honoring length, character sets, and ambiguous exclusion", () => {
    const pw = generatePassword({
      length: 24,
      uppercase: true,
      lowercase: true,
      digits: true,
      symbols: true,
      excludeAmbiguous: true,
    });
    expect(pw).toHaveLength(24);
    expect(/[A-Z]/.test(pw)).toBe(true);
    expect(/[a-z]/.test(pw)).toBe(true);
    expect(/[0-9]/.test(pw)).toBe(true);
    expect(/[^A-Za-z0-9]/.test(pw)).toBe(true);
    expect(/[0Oo1lI]/.test(pw)).toBe(false);
  });

  it("generates memorable passphrases with expected word count and separator", () => {
    const phrase = generatePassphrase({
      words: 5,
      separator: "-",
      capitalize: true,
      includeNumber: true,
    });
    const parts = phrase.split("-");
    expect(parts).toHaveLength(5);
    expect(parts.every((p) => /^[A-Z][a-z]+\d*$/.test(p))).toBe(true);
    expect(/\d/.test(phrase)).toBe(true);
  });

  it("estimates password strength across weak and strong inputs", () => {
    expect(estimatePasswordStrength("").level).toBe("weak");
    expect(estimatePasswordStrength("123456").level).toBe("weak");
    expect(estimatePasswordStrength("Correct-Horse-Battery-99!").level).toBe(
      "very-strong",
    );
  });
});

describe("generated passphrase strength", () => {
  it("counts choices rather than the length or capitalization of words", () => {
    expect(estimatePassphraseStrength({ words: 3, includeNumber: false })).toEqual({ entropyBits: 33, level: "weak" });
    expect(estimatePassphraseStrength({ words: 3, includeNumber: false, capitalize: false, separator: "---" })).toEqual({ entropyBits: 33, level: "weak" });
    expect(estimatePassphraseStrength({ words: 5, includeNumber: false })).toEqual({ entropyBits: 55, level: "fair" });
    expect(estimatePassphraseStrength({ words: 5, includeNumber: true }).entropyBits).toBeCloseTo(55 + Math.log2(500));
    expect(estimatePassphraseStrength({ words: 8, includeNumber: false }).level).toBe("very-strong");
  });
  it("defaults to a strong passphrase", () => {
    expect(estimatePassphraseStrength().level).toBe("strong");
  });
  it("keeps the wordlist bound after applying or saving a generated phrase", () => {
    expect(estimatePasswordStrength("Abandon-Ability-Able")).toEqual({ entropyBits: 33, level: "weak" });
    expect(estimatePasswordStrength("abandon-ability-able")).toEqual({ entropyBits: 33, level: "weak" });
    expect(estimatePasswordStrength("Abandon-Ability0-Able").entropyBits).toBeCloseTo(33 + Math.log2(300));
  });
  it("uses the same word-count limits as generation", () => {
    expect(estimatePassphraseStrength({ words: 1, includeNumber: false }).entropyBits).toBe(33);
    expect(estimatePassphraseStrength({ words: 20, includeNumber: false }).entropyBits).toBe(110);
  });
  it("uses the full BIP-39 English wordlist", () => {
    expect(PASSPHRASE_WORDLIST).toHaveLength(2048);
    expect(new Set(PASSPHRASE_WORDLIST).size).toBe(2048);
    expect(PASSPHRASE_WORDLIST.every((word) => /^[a-z]{3,8}$/.test(word))).toBe(true);
    expect(PASSPHRASE_WORDLIST[0]).toBe("abandon");
    expect(PASSPHRASE_WORDLIST[2047]).toBe("zoo");
    // Same digest is asserted by the iOS copy in KinicVaultCoreTests.passphraseWordlistMatchesWeb.
    const digest = createHash("sha256").update(PASSPHRASE_WORDLIST.join("\n")).digest("hex");
    expect(digest).toBe("187db04a869dd9bc7be80d21a86497d692c0db6abd3aa8cb6be5d618ff757fae");
  });
});
