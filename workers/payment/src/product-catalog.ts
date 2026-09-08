// Where: workers/payment/src/product-catalog.ts
// What: Parses the server-owned IAP product catalog.
// Why: iOS must never choose how many database credits a product grants.

export type ProductCatalog = Map<string, bigint>;

export function parseProductCatalog(raw: string): ProductCatalog {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("IAP_PRODUCT_CATALOG_JSON must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("IAP_PRODUCT_CATALOG_JSON must be an object");
  }
  const catalog = new Map<string, bigint>();
  for (const [productId, cyclesValue] of Object.entries(parsed)) {
    if (!productId.trim() || productId !== productId.trim()) {
      throw new Error("IAP product id must be non-empty and trimmed");
    }
    const cycles = parseCycles(cyclesValue, productId);
    catalog.set(productId, cycles);
  }
  if (catalog.size === 0) {
    throw new Error("IAP product catalog must not be empty");
  }
  return catalog;
}

function parseCycles(value: unknown, productId: string): bigint {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error(`IAP product ${productId} cycles must be a string or number`);
  }
  const text = String(value);
  if (!/^[1-9][0-9]*$/u.test(text)) {
    throw new Error(`IAP product ${productId} cycles must be a positive integer`);
  }
  const cycles = BigInt(text);
  if (cycles > 9_223_372_036_854_775_807n) {
    throw new Error(`IAP product ${productId} cycles exceed canister limit`);
  }
  return cycles;
}
