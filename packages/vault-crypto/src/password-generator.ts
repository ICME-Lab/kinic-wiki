import { PASSPHRASE_WORDLIST } from "./passphrase-wordlist.ts";

export type PasswordOptions = {
  length: number;
  uppercase: boolean;
  lowercase: boolean;
  digits: boolean;
  symbols: boolean;
  excludeAmbiguous: boolean;
};

export type PassphraseOptions = {
  words: number;
  separator: string;
  capitalize: boolean;
  includeNumber: boolean;
};

export type PasswordStrengthLevel = "weak" | "fair" | "strong" | "very-strong";

export type PasswordStrength = {
  level: PasswordStrengthLevel;
  entropyBits: number;
};

const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LOWER = "abcdefghijklmnopqrstuvwxyz";
const DIGITS = "0123456789";
const SYMBOLS = "!@#$%^&*()-_=+[]{}|;:,.<>?";
const AMBIGUOUS = new Set(["0", "O", "o", "1", "l", "I"]);

const WORDLIST = PASSPHRASE_WORDLIST;
const WORDSET: ReadonlySet<string> = new Set(WORDLIST);

function randomInt(maxExclusive: number): number {
  if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0) {
    throw new Error("InvalidRange");
  }
  if (maxExclusive === 1) return 0;
  const limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive;
  const buf = new Uint32Array(1);
  while (true) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % maxExclusive;
  }
}

function filterChars(charset: string, excludeAmbiguous: boolean): string {
  if (!excludeAmbiguous) return charset;
  return [...charset].filter((ch) => !AMBIGUOUS.has(ch)).join("");
}

export const DEFAULT_PASSWORD_OPTIONS: PasswordOptions = {
  length: 20,
  uppercase: true,
  lowercase: true,
  digits: true,
  symbols: true,
  excludeAmbiguous: false,
};

export function generatePassword(
  partial: Partial<PasswordOptions> = {},
): string {
  const opts: PasswordOptions = { ...DEFAULT_PASSWORD_OPTIONS, ...partial };
  const length = Math.max(8, Math.min(128, Math.floor(opts.length)));

  const pools: string[] = [];
  if (opts.uppercase) pools.push(filterChars(UPPER, opts.excludeAmbiguous));
  if (opts.lowercase) pools.push(filterChars(LOWER, opts.excludeAmbiguous));
  if (opts.digits) pools.push(filterChars(DIGITS, opts.excludeAmbiguous));
  if (opts.symbols) pools.push(filterChars(SYMBOLS, opts.excludeAmbiguous));

  if (pools.length === 0) {
    pools.push(filterChars(LOWER, opts.excludeAmbiguous));
  }

  const combined = pools.join("");
  const chars: string[] = [];

  // Guarantee at least one character from each enabled pool.
  for (const pool of pools) {
    if (chars.length < length) {
      chars.push(pool[randomInt(pool.length)]);
    }
  }
  while (chars.length < length) {
    chars.push(combined[randomInt(combined.length)]);
  }

  // Fisher-Yates shuffle using unbiased crypto randomness.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    const tmp = chars[i];
    chars[i] = chars[j];
    chars[j] = tmp;
  }

  return chars.join("");
}

export const DEFAULT_PASSPHRASE_OPTIONS: PassphraseOptions = {
  words: 5,
  separator: "-",
  capitalize: true,
  includeNumber: true,
};

export function generatePassphrase(
  partial: Partial<PassphraseOptions> = {},
): string {
  const opts: PassphraseOptions = { ...DEFAULT_PASSPHRASE_OPTIONS, ...partial };
  const count = Math.max(3, Math.min(10, Math.floor(opts.words)));
  const picked: string[] = [];
  for (let i = 0; i < count; i++) {
    let word = WORDLIST[randomInt(WORDLIST.length)];
    if (opts.capitalize) {
      word = word[0].toUpperCase() + word.slice(1);
    }
    picked.push(word);
  }
  if (opts.includeNumber) {
    const idx = randomInt(picked.length);
    picked[idx] = `${picked[idx]}${randomInt(100)}`;
  }
  return picked.join(opts.separator);
}

function strengthFromEntropy(entropyBits: number): PasswordStrength {
  const level = entropyBits < 40 ? "weak" : entropyBits < 60 ? "fair" : entropyBits < 85 ? "strong" : "very-strong";
  return { level, entropyBits };
}

/** Entropy of the generator's random choices. Formatting adds no randomness. */
export function estimatePassphraseStrength(partial: Partial<PassphraseOptions> = {}): PasswordStrength {
  const opts = { ...DEFAULT_PASSPHRASE_OPTIONS, ...partial };
  const count = Math.max(3, Math.min(10, Math.floor(opts.words)));
  return strengthFromEntropy(count * Math.log2(WORDLIST.length) + (opts.includeNumber ? Math.log2(count * 100) : 0));
}

export function estimatePasswordStrength(password: string): PasswordStrength {
  if (!password) return { level: "weak", entropyBits: 0 };
  // Recognize phrases produced by the UI even after applying/saving them.
  const parts = password.split("-");
  if (parts.length >= 3 && parts.length <= 10) {
    const words = parts.map(part => /^([a-z]+)([0-9]{1,2})?$/i.exec(part));
    const numbered = words.filter(word => word?.[2] !== undefined).length;
    if (numbered <= 1 && words.every(word => word && WORDSET.has(word[1].toLowerCase()))) {
      return estimatePassphraseStrength({ words: parts.length, includeNumber: numbered === 1 });
    }
  }
  let poolSize = 0;
  if (/[a-z]/.test(password)) poolSize += 26;
  if (/[A-Z]/.test(password)) poolSize += 26;
  if (/[0-9]/.test(password)) poolSize += 10;
  if (/[^a-zA-Z0-9]/.test(password)) poolSize += 32;
  if (poolSize === 0) poolSize = 1;

  const uniqueRatio = new Set(password).size / password.length;
  const effectiveLength = password.length * (0.5 + 0.5 * uniqueRatio);
  const entropyBits = Math.round(effectiveLength * Math.log2(poolSize));

  const strength = strengthFromEntropy(entropyBits);
  return password.length < 8 ? { ...strength, level: "weak" } : strength;
}
