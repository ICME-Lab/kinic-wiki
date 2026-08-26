import { describe, expect, it } from "vitest";
import { generateIiKey } from "../src/auth/internet-identity.js";
import { restoreReviewServiceIdentity } from "../src/auth/review-identity.js";

describe("review service identity", () => {
  it("restores only the configured Ed25519 principal", () => {
    const identity = generateIiKey();
    const restored = restoreReviewServiceIdentity(
      JSON.stringify(identity.toJSON()),
      identity.getPrincipal().toText()
    );
    expect(restored.getPrincipal().toText()).toBe(identity.getPrincipal().toText());
  });

  it("rejects malformed keys and principal mismatches", () => {
    const identity = generateIiKey();
    expect(() => restoreReviewServiceIdentity("not-json", identity.getPrincipal().toText())).toThrow(
      /identity key is invalid/u
    );
    expect(() =>
      restoreReviewServiceIdentity(JSON.stringify(identity.toJSON()), generateIiKey().getPrincipal().toText())
    ).toThrow(/principal does not match/u);
  });
});
