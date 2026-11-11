import { expect, it } from "vitest";
import { ownerKeyInput } from "../src/index";
it("binds vetKeys input to the raw caller principal, vault and big-endian epoch", () => {
  const input = ownerKeyInput(
    new Uint8Array([4, 5]),
    new Uint8Array(16).fill(8),
    258n,
  );
  expect([...input]).toEqual([
    ...new TextEncoder().encode("kinic-wiki/private-vault/v1"),
    2,
    4,
    5,
    ...new Uint8Array(16).fill(8),
    0,
    0,
    0,
    0,
    0,
    0,
    1,
    2,
  ]);
  expect(
    ownerKeyInput(new Uint8Array([4]), new Uint8Array(16), 0n),
  ).not.toEqual(ownerKeyInput(new Uint8Array([5]), new Uint8Array(16), 0n));
});
it("selects the persisted Vault key name in its own realm and rejects unknown anchors", async () => {
  const { anchoredMaster } = await import("../src/index");
  const { MasterPublicKey, MasterPublicKeyId, PocketIcMasterPublicKeyId } =
    await import("@icp-sdk/vetkeys");
  expect(anchoredMaster("test_key_1", true).publicKeyBytes()).toEqual(
    MasterPublicKey.pocketicKey(
      PocketIcMasterPublicKeyId.TEST_KEY_1,
    ).publicKeyBytes(),
  );
  expect(anchoredMaster("key_1", true).publicKeyBytes()).toEqual(
    MasterPublicKey.pocketicKey(
      PocketIcMasterPublicKeyId.KEY_1,
    ).publicKeyBytes(),
  );
  expect(anchoredMaster("test_key_1", false).publicKeyBytes()).toEqual(
    MasterPublicKey.productionKey(
      MasterPublicKeyId.TEST_KEY_1,
    ).publicKeyBytes(),
  );
  expect(anchoredMaster("key_1", false).publicKeyBytes()).toEqual(
    MasterPublicKey.productionKey(MasterPublicKeyId.KEY_1).publicKeyBytes(),
  );
  expect(() => anchoredMaster("unrecognized_key", false)).toThrow(
    "UnsupportedKey",
  );
});
