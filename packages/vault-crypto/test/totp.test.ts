import { describe, expect, it } from "vitest";
import {
  decodeBase32,
  formatTotpCode,
  generateTotp,
  parseTotpInput,
} from "../src/totp.ts";

// Official RFC 6238 ASCII seeds encoded in Base32:
// SHA-1 seed:   "12345678901234567890"
const RFC_SHA1 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
// SHA-256 seed: "12345678901234567890123456789012"
const RFC_SHA256 =
  "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA====";
// SHA-512 seed: "1234567890123456789012345678901234567890123456789012345678901234"
const RFC_SHA512 =
  "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNA=";

describe("RFC 6238 TOTP generator", () => {
  it("matches official RFC 6238 test vectors across SHA-1, SHA-256, and SHA-512", async () => {
    const sha1At59 = await generateTotp(
      { secret: RFC_SHA1, algorithm: "SHA-1", digits: 8, period: 30 },
      59 * 1000,
    );
    expect(sha1At59.code).toBe("94287082");
    expect(sha1At59.remainingSeconds).toBe(1);

    const sha1At1111111109 = await generateTotp(
      { secret: RFC_SHA1, algorithm: "SHA-1", digits: 8, period: 30 },
      1111111109 * 1000,
    );
    expect(sha1At1111111109.code).toBe("07081804");

    const sha256 = await generateTotp(
      { secret: RFC_SHA256, algorithm: "SHA-256", digits: 8, period: 30 },
      1111111109 * 1000,
    );
    expect(sha256.code).toBe("68084774");

    const sha512 = await generateTotp(
      { secret: RFC_SHA512, algorithm: "SHA-512", digits: 8, period: 30 },
      1234567890 * 1000,
    );
    expect(sha512.code).toBe("93441116");
  });

  it("parses otpauth URIs and spaced Base32 secrets", async () => {
    const parsed = parseTotpInput(
      `otpauth://totp/GitHub:alice?secret=${RFC_SHA1}&issuer=GitHub&digits=6&period=30`,
    );
    expect(parsed).toEqual({
      secret: RFC_SHA1,
      algorithm: "SHA-1",
      digits: 6,
      period: 30,
      issuer: "GitHub",
      label: "GitHub:alice",
    });

    const spaced = await generateTotp("gezd gnbv-gy3t qojq gezd gnbv gy3t qojq", 59 * 1000);
    expect(spaced.code).toBe("287082");
    expect(formatTotpCode(spaced.code)).toBe("287 082");
  });

  it("rejects invalid Base32 and unsupported OTP URIs", () => {
    expect(() => decodeBase32("!!!")).toThrow("InvalidTotpSecret");
    expect(() => parseTotpInput("otpauth://hotp/Test?secret=JBSWY3DPEHPK3PXP")).toThrow(
      "UnsupportedOtpType",
    );
    expect(() =>
      parseTotpInput("otpauth://totp/Test?secret=JBSWY3DPEHPK3PXP&digits=4"),
    ).toThrow("InvalidTotpDigits");
  });
});
