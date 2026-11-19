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

// Compact, unambiguous high-readability English wordlist (256 words = 8 bits/word).
const WORDLIST = [
  "acorn", "agate", "alder", "amber", "anchor", "anise", "apple", "apron",
  "arbor", "arrow", "aspen", "atlas", "attic", "audio", "autumn", "avocado",
  "badge", "baker", "bamboo", "banjo", "barley", "basil", "basin", "beacon",
  "beaver", "berry", "birch", "bison", "blade", "bloom", "bluff", "boulder",
  "branch", "breeze", "bridge", "brook", "brush", "buckle", "butter", "cabin",
  "cactus", "cairn", "camera", "candle", "canopy", "canyon", "carbon", "carpet",
  "carrot", "castle", "cedar", "celery", "chalk", "channel", "cherry", "chisel",
  "cider", "cinder", "citrus", "clasp", "clover", "cobalt", "coffee", "comet",
  "compass", "copper", "coral", "cotton", "cradle", "crater", "creek", "crest",
  "crimson", "crown", "crystal", "cypress", "dagger", "daisy", "dancer", "dawn",
  "delta", "desert", "diamond", "dolphin", "domino", "dragon", "drift", "drizzle",
  "eagle", "earth", "eclipse", "ember", "emerald", "engine", "falcon", "feather",
  "fennel", "fern", "fiddle", "field", "figure", "finch", "fjord", "flame",
  "flint", "flora", "flute", "forest", "fossil", "fountain", "frost", "galaxy",
  "garden", "garlic", "garnet", "geyser", "ginger", "glacier", "glade", "glider",
  "granite", "grape", "gravel", "griffin", "grove", "guitar", "harbor", "harvest",
  "hazel", "heather", "helmet", "heron", "hickory", "hilltop", "hollow", "honey",
  "horizon", "iceberg", "indigo", "island", "ivory", "jacket", "jade", "jasmine",
  "jasper", "jigsaw", "juniper", "kayak", "kelp", "kernel", "kettle", "kestrel",
  "lantern", "larch", "laurel", "lavender", "lemon", "lichen", "lilac", "linden",
  "lizard", "lotus", "lumber", "magnet", "magpie", "mango", "maple", "marble",
  "marina", "meadow", "melon", "mercury", "meteor", "mineral", "mint", "mirror",
  "monarch", "monkey", "monolith", "moon", "moss", "muffin", "mulberry", "nebula",
  "nectar", "needle", "nickel", "nimbus", "nutmeg", "oasis", "obsidian", "ocean",
  "ochre", "olive", "onyx", "opal", "orange", "orbit", "orchid", "oriole",
  "osprey", "otter", "oyster", "paddle", "palace", "panther", "papaya", "parcel",
  "parrot", "pebble", "pecan", "pelican", "pepper", "petrel", "pewter", "phoenix",
  "picnic", "pigeon", "pillar", "pine", "planet", "plaza", "plover", "plum",
  "pocket", "poplar", "portal", "prairie", "prism", "puffin", "pumpkin", "quartz",
  "quiver", "rabbit", "radish", "rainbow", "ranger", "raven", "redwood", "reef",
  "ribbon", "ridge", "ripple", "river", "robin", "rocket", "rosemary", "ruby",
  "saffron", "sage", "salmon", "sandal", "sapphire", "saturn", "scarlet", "summit",
];

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

export function estimatePasswordStrength(password: string): PasswordStrength {
  if (!password) return { level: "weak", entropyBits: 0 };
  let poolSize = 0;
  if (/[a-z]/.test(password)) poolSize += 26;
  if (/[A-Z]/.test(password)) poolSize += 26;
  if (/[0-9]/.test(password)) poolSize += 10;
  if (/[^a-zA-Z0-9]/.test(password)) poolSize += 32;
  if (poolSize === 0) poolSize = 1;

  const uniqueRatio = new Set(password).size / password.length;
  const effectiveLength = password.length * (0.5 + 0.5 * uniqueRatio);
  const entropyBits = Math.round(effectiveLength * Math.log2(poolSize));

  let level: PasswordStrengthLevel;
  if (entropyBits < 40 || password.length < 8) {
    level = "weak";
  } else if (entropyBits < 60) {
    level = "fair";
  } else if (entropyBits < 85) {
    level = "strong";
  } else {
    level = "very-strong";
  }
  return { level, entropyBits };
}
