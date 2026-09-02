import assert from "node:assert/strict";
import test from "node:test";
import { calculateCycles, validateCatalog } from "./validate-iap-catalog.mjs";

const record = {
  schemaVersion: 1,
  status: "sandbox-approved",
  productId: "xyz.kinic.dbcredits.small",
  type: "CONSUMABLE",
  baseTerritory: "USA",
  customerPriceUsd: "4.99",
  xdrUsdRate: "1.368360",
  amountCycles: "1823000000000",
  appStorePriceReadbackAt: "2026-09-02T07:17:04Z"
};

const sandboxConfig = {
  vars: { IAP_PRODUCT_CATALOG_JSON: '{"xyz.kinic.dbcredits.small":"1823000000000"}' }
};
const productionConfig = {
  vars: {
    IAP_PRODUCT_CATALOG_JSON:
      '{"xyz.kinic.dbcredits.small":"1823000000000","xyz.kinic.dbcredits.medium":"1","xyz.kinic.dbcredits.large":"1"}'
  }
};

test("calculates cycles with exact decimal arithmetic and a 1B floor", () => {
  assert.equal(calculateCycles("4.99", "1.368360"), 1_823_000_000_000n);
});

test("accepts the one-product sandbox catalog", () => {
  validateCatalog({ record, sandboxConfig, productionConfig });
});

test("rejects a production deploy before price readback approval", () => {
  assert.throws(
    () => validateCatalog({ record, sandboxConfig, productionConfig, production: true }),
    /not approved/
  );
});
