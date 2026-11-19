export type TotpAlgorithm = "SHA-1" | "SHA-256" | "SHA-512";

export type TotpConfig = {
  secret: string;
  algorithm: TotpAlgorithm;
  digits: number;
  period: number;
  issuer?: string;
  label?: string;
};

export type TotpCode = {
  code: string;
  remainingSeconds: number;
  period: number;
};

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function decodeBase32(input: string): Uint8Array {
  const cleaned = input.toUpperCase().replace(/[\s-]+/g, "").replace(/=+$/g, "");
  if (!cleaned) throw new Error("InvalidTotpSecret");

  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const ch of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error("InvalidTotpSecret");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }
  if (bytes.length === 0) throw new Error("InvalidTotpSecret");
  return new Uint8Array(bytes);
}

function parseAlgorithm(raw: string | null): TotpAlgorithm {
  if (raw === null) return "SHA-1";
  const upper = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (upper === "SHA1") return "SHA-1";
  if (upper === "SHA256") return "SHA-256";
  if (upper === "SHA512") return "SHA-512";
  throw new Error("UnsupportedTotpAlgorithm");
}

export function parseTotpInput(input: string): TotpConfig {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("InvalidTotpSecret");

  if (trimmed.toLowerCase().startsWith("otpauth://")) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      throw new Error("InvalidTotpUri");
    }
    if (url.hostname.toLowerCase() !== "totp") {
      throw new Error("UnsupportedOtpType");
    }
    const known = new Set(["secret", "algorithm", "digits", "period", "issuer"]);
    const params = new Map<string, string>();
    for (const [rawName, value] of url.searchParams) {
      const name = rawName.toLowerCase();
      if (!known.has(name)) continue;
      if (params.has(name)) throw new Error("InvalidTotpUri");
      params.set(name, value);
    }
    const secret = params.get("secret")?.trim() ?? "";
    decodeBase32(secret);

    const algorithm = parseAlgorithm(params.get("algorithm") ?? null);
    const digitsRaw = params.get("digits");
    if (digitsRaw !== undefined && !/^[0-9]+$/.test(digitsRaw)) throw new Error("InvalidTotpDigits");
    const digits = digitsRaw === undefined ? 6 : Number(digitsRaw);
    if (!Number.isInteger(digits) || digits < 6 || digits > 8) {
      throw new Error("InvalidTotpDigits");
    }
    const periodRaw = params.get("period");
    if (periodRaw !== undefined && !/^[0-9]+$/.test(periodRaw)) throw new Error("InvalidTotpPeriod");
    const period = periodRaw === undefined ? 30 : Number(periodRaw);
    if (!Number.isInteger(period) || period < 1 || period > 300) {
      throw new Error("InvalidTotpPeriod");
    }
    const label = decodeURIComponent(url.pathname.replace(/^\/+/, "")).trim();
    const issuer = params.get("issuer")?.trim();

    return {
      secret,
      algorithm,
      digits,
      period,
      ...(issuer ? { issuer } : {}),
      ...(label ? { label } : {}),
    };
  }

  decodeBase32(trimmed);
  return {
    secret: trimmed,
    algorithm: "SHA-1",
    digits: 6,
    period: 30,
  };
}

export async function generateTotp(
  input: string | TotpConfig,
  nowMs: number = Date.now(),
): Promise<TotpCode> {
  const config = typeof input === "string" ? parseTotpInput(input) : input;
  if (!Number.isInteger(config.digits) || config.digits < 6 || config.digits > 8) throw new Error("InvalidTotpDigits");
  if (!Number.isInteger(config.period) || config.period < 1 || config.period > 300) throw new Error("InvalidTotpPeriod");
  const keyBytes = decodeBase32(config.secret);

  const epochSeconds = Math.floor(nowMs / 1000);
  const counter = BigInt(Math.floor(epochSeconds / config.period));
  const elapsed = ((epochSeconds % config.period) + config.period) % config.period;
  const remainingSeconds = config.period - elapsed;

  const counterBytes = new Uint8Array(8);
  new DataView(counterBytes.buffer).setBigUint64(0, counter, false);

  try {
    const keyBuffer = new Uint8Array(keyBytes).buffer;
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      keyBuffer,
      { name: "HMAC", hash: { name: config.algorithm } },
      false,
      ["sign"],
    );
    const mac = new Uint8Array(
      await crypto.subtle.sign("HMAC", cryptoKey, counterBytes),
    );
    const offset = mac[mac.length - 1] & 0x0f;
    const binary =
      ((mac[offset] & 0x7f) << 24) |
      ((mac[offset + 1] & 0xff) << 16) |
      ((mac[offset + 2] & 0xff) << 8) |
      (mac[offset + 3] & 0xff);
    const modulo = 10 ** config.digits;
    const code = String(binary % modulo).padStart(config.digits, "0");
    return {
      code,
      remainingSeconds,
      period: config.period,
    };
  } finally {
    keyBytes.fill(0);
  }
}

export function formatTotpCode(code: string): string {
  if (code.length === 6) return `${code.slice(0, 3)} ${code.slice(3)}`;
  if (code.length === 8) return `${code.slice(0, 4)} ${code.slice(4)}`;
  return code;
}
