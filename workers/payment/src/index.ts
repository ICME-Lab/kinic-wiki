// Where: workers/payment/src/index.ts
// What: HTTP API for App Store IAP database credit fulfillment.
// Why: iOS purchases need server verification before the VFS canister grants credits.

import type { RuntimeEnv } from "./env.js";
import { verifyStoreKitTransaction, transactionPayload } from "./app-store.js";
import { verifyAppStoreNotification } from "./app-store-notification.js";
import { parseProductCatalog } from "./product-catalog.js";
import { grantDatabaseCyclesFromIap } from "./vfs.js";

const FULFILLMENT_GRANT_LEASE_MS = 5 * 60 * 1000;
const PURCHASE_INTENT_ENDPOINT = "iap:purchase-intents";
const ACTIVATE_DATABASE_ENDPOINT = "iap:activate-database";

type ActivateDatabaseInput = {
  transactionJWS: string;
};

type PurchaseIntentInput = {
  databaseId: string;
  purchaserPrincipal: string;
  productId: string;
};

type FulfillmentRow = {
  transaction_id: string;
  database_id: string;
  purchaser_principal: string;
  app_account_token: string | null;
  product_id: string;
  environment: string;
  bundle_id: string;
  cycles: string;
  status: string;
};

type PurchaseIntentRow = {
  app_account_token: string;
  database_id: string;
  purchaser_principal: string;
  product_id: string;
  amount_cycles: string | null;
  status: string;
  transaction_id: string | null;
};

class ActivationError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = "ActivationError";
  }
}

type PaymentWorkerDependencies = {
  grant: typeof grantDatabaseCyclesFromIap;
  fetcher: typeof fetch;
};

export function createPaymentWorker(dependencies: Partial<PaymentWorkerDependencies> = {}) {
  const grant = dependencies.grant ?? grantDatabaseCyclesFromIap;
  const fetcher = dependencies.fetcher ?? fetch;
  return {
    async fetch(request: Request, env: RuntimeEnv): Promise<Response> {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/iap/purchase-intents") {
        const globalLimitError = await rateLimitErrorResponse(env, PURCHASE_INTENT_ENDPOINT);
        if (globalLimitError) return globalLimitError;
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return jsonResponse({ error: "invalid JSON body" }, 400);
        }
        try {
          const input = parsePurchaseIntentInput(body);
          const principalLimitError = await rateLimitErrorResponse(env, PURCHASE_INTENT_ENDPOINT, input.purchaserPrincipal);
          if (principalLimitError) return principalLimitError;
          return jsonResponse(await createPurchaseIntent(env, input));
        } catch (error) {
          return jsonResponse({ error: errorMessage(error) }, 400);
        }
      }
      if (request.method === "POST" && url.pathname === "/iap/activate-database") {
        const globalLimitError = await rateLimitErrorResponse(env, ACTIVATE_DATABASE_ENDPOINT);
        if (globalLimitError) return globalLimitError;
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return jsonResponse({ error: "invalid JSON body" }, 400);
        }
        try {
          const input = parseActivateDatabaseInput(body);
          const principalLimitKey = await activationRateLimitKey(env, input.transactionJWS);
          const principalLimitError = await rateLimitErrorResponse(env, ACTIVATE_DATABASE_ENDPOINT, principalLimitKey);
          if (principalLimitError) return principalLimitError;
          return jsonResponse(await activateDatabase(env, input, grant, fetcher));
        } catch (error) {
          const message = errorMessage(error);
          if (error instanceof ActivationError) {
            return jsonResponse({ error: message, retryable: error.retryable }, error.status);
          }
          return jsonResponse({ error: message, retryable: false }, 400);
        }
      }
      if (request.method === "POST" && url.pathname === "/iap/app-store-notifications") {
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return jsonResponse({ error: "invalid JSON body" }, 400);
        }
        try {
          await recordAppStoreNotification(env, await parseNotificationInput(body, env));
          return jsonResponse({ accepted: true });
        } catch (error) {
          return jsonResponse({ error: errorMessage(error) }, 400);
        }
      }
      return jsonResponse({ error: "not found" }, 404);
    }
  };
}

export default createPaymentWorker();

export async function createPurchaseIntent(env: RuntimeEnv, input: PurchaseIntentInput): Promise<{ appAccountToken: string }> {
  const catalog = parseProductCatalog(env.IAP_PRODUCT_CATALOG_JSON);
  const amountCycles = catalog.get(input.productId);
  if (amountCycles === undefined) {
    throw new Error(`unknown IAP product: ${input.productId}`);
  }
  const now = Date.now();
  const appAccountToken = crypto.randomUUID().toLowerCase();
  await env.DB.prepare(
    "INSERT INTO iap_purchase_intents (app_account_token, database_id, purchaser_principal, product_id, amount_cycles, status, created_at_ms, updated_at_ms) VALUES (?1, ?2, ?3, ?4, ?5, 'created', ?6, ?6)"
  )
    .bind(appAccountToken, input.databaseId, input.purchaserPrincipal, input.productId, amountCycles.toString(), now)
    .run();
  return { appAccountToken };
}

export async function activateDatabase(
  env: RuntimeEnv,
  input: ActivateDatabaseInput,
  grant: typeof grantDatabaseCyclesFromIap = grantDatabaseCyclesFromIap,
  fetcher: typeof fetch = fetch
): Promise<Record<string, string | boolean>> {
  const catalog = parseProductCatalog(env.IAP_PRODUCT_CATALOG_JSON);
  const devicePayload = transactionPayload(input.transactionJWS);
  const transactionId = requiredText(devicePayload.transactionId, "transactionId");
  const deviceAppAccountToken = optionalUuidText(devicePayload.appAccountToken, "appAccountToken");
  const existingFulfillment = await fulfillmentByTransaction(env, transactionId);
  if (existingFulfillment?.status === "fulfilled") {
    return fulfilledActivationResponse(existingFulfillment, deviceAppAccountToken);
  }
  const verified = await verifyStoreKitTransaction(env, input.transactionJWS, catalog, fetcher);
  const intent = await validatePurchaseIntent(env, {
    appAccountToken: verified.appAccountToken,
    productId: verified.productId,
    transactionId
  });
  const fulfillment = await ensureFulfillmentReceived(env, {
    transactionId,
    databaseId: intent.database_id,
    purchaserPrincipal: intent.purchaser_principal
  });
  if (fulfillment.status === "fulfilled") {
    return fulfilledActivationResponse(fulfillment, verified.appAccountToken);
  }
  const amountCycles = parseAmountCyclesSnapshot(intent.amount_cycles);
  const claim = await markFulfillmentGranting(env, {
    transactionId,
    databaseId: intent.database_id,
    purchaserPrincipal: intent.purchaser_principal,
    appAccountToken: verified.appAccountToken,
    productId: verified.productId,
    environment: verified.environment,
    bundleId: verified.bundleId,
    cycles: amountCycles.toString(),
  });
  if (claim.fulfillment) {
    return fulfilledActivationResponse(claim.fulfillment, verified.appAccountToken);
  }
  try {
    await grant(env, {
      databaseId: intent.database_id,
      amountCycles,
      externalPaymentId: transactionId,
      provider: "apple_iap",
      productId: verified.productId,
      purchaserPrincipal: intent.purchaser_principal
    });
  } catch (error) {
    try {
      await markFulfillmentFailed(env, transactionId, claim.attemptId, errorMessage(error));
    } catch {
      // The lease permits recovery even if D1 is temporarily unavailable here.
    }
    throw new ActivationError(`VFS grant failed: ${errorMessage(error)}`, 502, true);
  }
  try {
    await finalizeFulfillment(env, {
      transactionId,
      databaseId: intent.database_id,
      purchaserPrincipal: intent.purchaser_principal,
      appAccountToken: verified.appAccountToken,
      productId: verified.productId,
      attemptId: claim.attemptId
    });
  } catch (error) {
    try {
      await markFulfillmentFailed(env, transactionId, claim.attemptId, errorMessage(error));
    } catch {
      // A failed lease remains reclaimable after its deadline.
    }
    throw error;
  }
  return {
    fulfilled: true,
    transactionId,
    databaseId: intent.database_id,
    purchaserPrincipal: intent.purchaser_principal,
    productId: verified.productId,
    cycles: amountCycles.toString()
  };
}

function parseActivateDatabaseInput(body: unknown): ActivateDatabaseInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("request body must be an object");
  }
  const record = body as Record<string, unknown>;
  return {
    transactionJWS: requiredText(record.transactionJWS, "transactionJWS")
  };
}

function parsePurchaseIntentInput(body: unknown): PurchaseIntentInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("request body must be an object");
  }
  const record = body as Record<string, unknown>;
  return {
    databaseId: requiredText(record.databaseId, "databaseId"),
    purchaserPrincipal: requiredPrincipalText(record.purchaserPrincipal, "purchaserPrincipal"),
    productId: requiredText(record.productId, "productId")
  };
}

async function parseNotificationInput(body: unknown, env: RuntimeEnv): Promise<{ notificationUUID: string; notificationType: string; subtype: string | null; transactionId: string | null; signedPayload: string }> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("notification body must be an object");
  }
  const record = body as Record<string, unknown>;
  const signedPayload = requiredText(record.signedPayload, "signedPayload");
  return verifyAppStoreNotification(env, signedPayload);
}

async function recordAppStoreNotification(env: RuntimeEnv, input: { notificationUUID: string; notificationType: string; subtype: string | null; transactionId: string | null; signedPayload: string }): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO app_store_notifications (notification_uuid, notification_type, subtype, transaction_id, signed_payload, received_at_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(notification_uuid) DO NOTHING"
  )
    .bind(input.notificationUUID, input.notificationType, input.subtype, input.transactionId, input.signedPayload, Date.now())
    .run();
}

async function fulfillmentByTransaction(env: RuntimeEnv, transactionId: string): Promise<FulfillmentRow | null> {
  return env.DB.prepare(
    "SELECT transaction_id, database_id, purchaser_principal, app_account_token, product_id, environment, bundle_id, cycles, status FROM iap_fulfillments WHERE transaction_id = ?1"
  )
    .bind(transactionId)
    .first<FulfillmentRow>();
}

async function purchaseIntentByToken(env: RuntimeEnv, appAccountToken: string): Promise<PurchaseIntentRow | null> {
  return env.DB.prepare(
    "SELECT app_account_token, database_id, purchaser_principal, product_id, amount_cycles, status, transaction_id FROM iap_purchase_intents WHERE app_account_token = ?1"
  )
    .bind(appAccountToken)
    .first<PurchaseIntentRow>();
}

async function validatePurchaseIntent(
  env: RuntimeEnv,
  input: { appAccountToken: string; productId: string; transactionId: string }
): Promise<PurchaseIntentRow> {
  const intent = await purchaseIntentByToken(env, input.appAccountToken);
  if (!intent) {
    throw new Error("purchase intent not found");
  }
  if (intent.product_id !== input.productId) {
    throw new Error("purchase intent product mismatch");
  }
  if (intent.status === "fulfilled" && intent.transaction_id === input.transactionId) {
    return intent;
  }
  if (intent.status !== "created") {
    throw new Error("purchase intent is not active");
  }
  parseAmountCyclesSnapshot(intent.amount_cycles);
  return intent;
}

function parseAmountCyclesSnapshot(value: string | null): bigint {
  if (!value || !/^[1-9][0-9]*$/u.test(value)) {
    throw new Error("purchase intent is missing a valid cycles snapshot");
  }
  const cycles = BigInt(value);
  if (cycles > 9_223_372_036_854_775_807n) {
    throw new Error("purchase intent cycles snapshot exceeds canister limit");
  }
  return cycles;
}

async function ensureFulfillmentReceived(env: RuntimeEnv, input: { transactionId: string; databaseId: string; purchaserPrincipal: string }): Promise<FulfillmentRow> {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO iap_fulfillments (transaction_id, database_id, purchaser_principal, app_account_token, product_id, environment, bundle_id, cycles, status, error_message, created_at_ms, updated_at_ms) VALUES (?1, ?2, ?3, NULL, 'unknown', ?4, ?5, '0', 'received', NULL, ?6, ?6) ON CONFLICT(transaction_id) DO NOTHING"
  )
    .bind(input.transactionId, input.databaseId, input.purchaserPrincipal, env.APP_STORE_ENVIRONMENT, env.APP_STORE_BUNDLE_ID, now)
    .run();
  const fulfillment = await fulfillmentByTransaction(env, input.transactionId);
  if (!fulfillment) {
    throw new Error("fulfillment row was not created");
  }
  assertFulfillmentOwner(fulfillment, input.databaseId, input.purchaserPrincipal, "received");
  return fulfillment;
}

async function markFulfillmentGranting(env: RuntimeEnv, input: { transactionId: string; databaseId: string; purchaserPrincipal: string; appAccountToken: string; productId: string; environment: string; bundleId: string; cycles: string }): Promise<{ attemptId: string; fulfillment: null } | { attemptId: null; fulfillment: FulfillmentRow }> {
  const now = Date.now();
  const attemptId = crypto.randomUUID();
  const result = await env.DB.prepare(
    "UPDATE iap_fulfillments SET app_account_token = ?1, product_id = ?2, environment = ?3, bundle_id = ?4, cycles = ?5, status = 'granting', grant_attempt_id = ?6, error_message = NULL, updated_at_ms = ?7 WHERE transaction_id = ?8 AND database_id = ?9 AND purchaser_principal = ?10 AND (status IN ('received', 'failed') OR (status = 'granting' AND updated_at_ms <= ?11))"
  )
    .bind(input.appAccountToken, input.productId, input.environment, input.bundleId, input.cycles, attemptId, now, input.transactionId, input.databaseId, input.purchaserPrincipal, now - FULFILLMENT_GRANT_LEASE_MS)
    .run();
  if ((result.meta.changes ?? 0) !== 1) {
    const fulfillment = await fulfillmentByTransaction(env, input.transactionId);
    if (fulfillment?.status === "fulfilled") return { attemptId: null, fulfillment };
    if (fulfillment?.status === "granting") {
      throw new ActivationError("fulfillment grant is already in progress", 409, true);
    }
    throw new ActivationError("fulfillment state changed before granting", 409, true);
  }
  return { attemptId, fulfillment: null };
}

async function finalizeFulfillment(env: RuntimeEnv, input: { transactionId: string; databaseId: string; purchaserPrincipal: string; appAccountToken: string; productId: string; attemptId: string }): Promise<void> {
  const now = Date.now();
  try {
    const results = await env.DB.batch([
      env.DB.prepare(
        "UPDATE iap_fulfillments SET status = 'fulfilled', grant_attempt_id = NULL, error_message = NULL, updated_at_ms = ?1 WHERE transaction_id = ?2 AND database_id = ?3 AND purchaser_principal = ?4 AND app_account_token = ?5 AND status = 'granting' AND grant_attempt_id = ?6"
      ).bind(now, input.transactionId, input.databaseId, input.purchaserPrincipal, input.appAccountToken, input.attemptId),
      env.DB.prepare(
        "UPDATE iap_purchase_intents SET status = 'fulfilled', transaction_id = ?1, updated_at_ms = ?2 WHERE app_account_token = ?3 AND database_id = ?4 AND purchaser_principal = ?5 AND product_id = ?6 AND (status = 'created' OR (status = 'fulfilled' AND transaction_id = ?1))"
      ).bind(input.transactionId, now, input.appAccountToken, input.databaseId, input.purchaserPrincipal, input.productId)
    ]);
    if (results.some((result) => (result.meta.changes ?? 0) !== 1)) {
      throw new Error("state mismatch");
    }
  } catch (error) {
    throw new ActivationError(`D1 finalization failed: ${errorMessage(error)}`, 502, true);
  }
}

async function markFulfillmentFailed(env: RuntimeEnv, transactionId: string, attemptId: string, message: string): Promise<void> {
  await env.DB.prepare("UPDATE iap_fulfillments SET status = 'failed', grant_attempt_id = NULL, error_message = ?1, updated_at_ms = ?2 WHERE transaction_id = ?3 AND status = 'granting' AND grant_attempt_id = ?4")
    .bind(message, Date.now(), transactionId, attemptId)
    .run();
}

function fulfilledActivationResponse(fulfillment: FulfillmentRow, deviceAppAccountToken: string | null): Record<string, string | boolean> {
  if (!deviceAppAccountToken || !fulfillment.app_account_token || deviceAppAccountToken !== fulfillment.app_account_token) {
    throw new Error("transaction already fulfilled for another purchase intent");
  }
  return {
    fulfilled: true,
    transactionId: fulfillment.transaction_id,
    databaseId: fulfillment.database_id,
    purchaserPrincipal: fulfillment.purchaser_principal,
    productId: fulfillment.product_id,
    cycles: fulfillment.cycles
  };
}

async function activationRateLimitKey(env: RuntimeEnv, transactionJWS: string): Promise<string> {
  const payload = transactionPayload(transactionJWS);
  const appAccountToken = optionalUuidText(payload.appAccountToken, "appAccountToken");
  if (!appAccountToken) {
    throw new Error("transaction appAccountToken is required");
  }
  const intent = await purchaseIntentByToken(env, appAccountToken);
  return intent?.purchaser_principal ?? appAccountToken;
}

function assertFulfillmentOwner(fulfillment: FulfillmentRow, databaseId: string, purchaserPrincipal: string, stateLabel: string): void {
  if (fulfillment.database_id !== databaseId) {
    throw new Error(`transaction already ${stateLabel} for another database`);
  }
  if (fulfillment.purchaser_principal !== purchaserPrincipal) {
    throw new Error(`transaction already ${stateLabel} for another purchaser`);
  }
}

async function rateLimitErrorResponse(env: RuntimeEnv, endpoint: string, purchaserPrincipal?: string): Promise<Response | null> {
  try {
    const outcome = purchaserPrincipal
      ? await env.IAP_PRINCIPAL_RATE_LIMITER.limit({ key: `${endpoint}:${purchaserPrincipal}` })
      : await env.IAP_GLOBAL_RATE_LIMITER.limit({ key: endpoint });
    if (!outcome.success) {
      return jsonResponse({ error: "rate limit exceeded", retryable: true }, 429);
    }
  } catch {
    return jsonResponse({ error: "rate limiter unavailable", retryable: true }, 503);
  }
  return null;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value;
}

function requiredPrincipalText(value: unknown, field: string): string {
  const text = requiredText(value, field);
  if (!/^[a-z0-9-]+$/u.test(text)) throw new Error(`${field} is invalid`);
  return text;
}

function optionalUuidText(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  const text = requiredText(value, field);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(text)) {
    throw new Error(`${field} is invalid`);
  }
  return text.toLowerCase();
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
