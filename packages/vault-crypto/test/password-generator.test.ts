import { describe, expect, it } from "vitest";
import {
  estimatePasswordStrength,
  estimatePassphraseStrength,
  generatePassphrase,
  generatePassword,
} from "../src/password-generator.ts";

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
    expect(estimatePassphraseStrength({ words: 3, includeNumber: false })).toEqual({ entropyBits: 24, level: "weak" });
    expect(estimatePassphraseStrength({ words: 3, includeNumber: false, capitalize: false, separator: "---" })).toEqual({ entropyBits: 24, level: "weak" });
    expect(estimatePassphraseStrength({ words: 5, includeNumber: false })).toEqual({ entropyBits: 40, level: "fair" });
    expect(estimatePassphraseStrength({ words: 5, includeNumber: true }).entropyBits).toBeCloseTo(40 + Math.log2(500));
    expect(estimatePassphraseStrength({ words: 8, includeNumber: false }).level).toBe("strong");
  });
  it("keeps the wordlist bound after applying or saving a generated phrase", () => {
    expect(estimatePasswordStrength("Acorn-Agate-Alder")).toEqual({ entropyBits: 24, level: "weak" });
    expect(estimatePasswordStrength("acorn-agate-alder")).toEqual({ entropyBits: 24, level: "weak" });
    expect(estimatePasswordStrength("Acorn-Agate0-Alder").entropyBits).toBeCloseTo(24 + Math.log2(300));
  });
  it("uses the same word-count limits as generation", () => {
    expect(estimatePassphraseStrength({ words: 1, includeNumber: false }).entropyBits).toBe(24);
    expect(estimatePassphraseStrength({ words: 20, includeNumber: false }).entropyBits).toBe(80);
  });
});
