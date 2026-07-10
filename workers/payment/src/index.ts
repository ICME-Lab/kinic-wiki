// Where: workers/payment/src/index.ts
// What: HTTP API for App Store IAP database credit fulfillment.
// Why: iOS purchases need server verification before the VFS canister grants credits.

import type { RuntimeEnv } from "./env.js";
import { verifyStoreKitTransaction, transactionPayload } from "./app-store.js";
import { verifyAppStoreNotification } from "./app-store-notification.js";
import { parseProductCatalog } from "./product-catalog.js";
import { grantDatabaseCyclesFromIap, type CyclesPurchaseResult } from "./vfs.js";

const PURCHASE_INTENT_TTL_MS = 30 * 60 * 1000;
const PURCHASE_INTENT_ENDPOINT = "iap:purchase-intents";
const ACTIVATE_DATABASE_ENDPOINT = "iap:activate-database";

type ActivateDatabaseInput = {
  databaseId: string;
  purchaserPrincipal: string;
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
  status: string;
  expires_at_ms: number;
  transaction_id: string | null;
};

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
          const principalLimitError = await rateLimitErrorResponse(env, ACTIVATE_DATABASE_ENDPOINT, input.purchaserPrincipal);
          if (principalLimitError) return principalLimitError;
          return jsonResponse(await activateDatabase(env, input, grant, fetcher));
        } catch (error) {
          const message = errorMessage(error);
          const retryable = isRetryableActivationError(message);
          return jsonResponse({ error: message, retryable }, retryable ? 502 : 400);
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

export async function createPurchaseIntent(env: RuntimeEnv, input: PurchaseIntentInput): Promise<{ appAccountToken: string; expiresAtMs: number }> {
  const catalog = parseProductCatalog(env.IAP_PRODUCT_CATALOG_JSON);
  if (!catalog.has(input.productId)) {
    throw new Error(`unknown IAP product: ${input.productId}`);
  }
  const now = Date.now();
  const appAccountToken = crypto.randomUUID().toLowerCase();
  const expiresAtMs = now + PURCHASE_INTENT_TTL_MS;
  await env.DB.prepare(
    "INSERT INTO iap_purchase_intents (app_account_token, database_id, purchaser_principal, product_id, status, expires_at_ms, created_at_ms, updated_at_ms) VALUES (?1, ?2, ?3, ?4, 'created', ?5, ?6, ?6)"
  )
    .bind(appAccountToken, input.databaseId, input.purchaserPrincipal, input.productId, expiresAtMs, now)
    .run();
  return { appAccountToken, expiresAtMs };
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
    return fulfilledActivationResponse(existingFulfillment, input, deviceAppAccountToken);
  }
  const verified = await verifyStoreKitTransaction(env, input.transactionJWS, catalog, fetcher);
  await validatePurchaseIntent(env, {
    appAccountToken: verified.appAccountToken,
    databaseId: input.databaseId,
    purchaserPrincipal: input.purchaserPrincipal,
    productId: verified.productId,
    transactionId
  });
  const fulfillment = await ensureFulfillmentReceived(env, {
    transactionId,
    databaseId: input.databaseId,
    purchaserPrincipal: input.purchaserPrincipal
  });
  if (fulfillment.status === "fulfilled") {
    return fulfilledActivationResponse(fulfillment, input, verified.appAccountToken);
  }
  const alreadyFulfilled = await markFulfillmentGranting(env, {
    transactionId,
    databaseId: input.databaseId,
    purchaserPrincipal: input.purchaserPrincipal,
    appAccountToken: verified.appAccountToken,
    productId: verified.productId,
    environment: verified.environment,
    bundleId: verified.bundleId,
    cycles: verified.cycles.toString(),
  });
  if (alreadyFulfilled) {
    return fulfilledActivationResponse(alreadyFulfilled, input, verified.appAccountToken);
  }
  let result: CyclesPurchaseResult;
  try {
    result = await grant(env, {
      databaseId: input.databaseId,
      amountCycles: verified.cycles,
      externalPaymentId: transactionId,
      provider: "apple_iap",
      productId: verified.productId,
      purchaserPrincipal: input.purchaserPrincipal
    });
  } catch (error) {
    await markFulfillmentFailed(env, transactionId, errorMessage(error));
    throw new Error(`VFS grant failed: ${errorMessage(error)}`);
  }
  await finalizeFulfillment(env, {
    transactionId,
    databaseId: input.databaseId,
    purchaserPrincipal: input.purchaserPrincipal,
    appAccountToken: verified.appAccountToken,
    productId: verified.productId
  });
  return {
    fulfilled: true,
    transactionId,
    databaseId: input.databaseId,
    productId: verified.productId,
    cycles: verified.cycles.toString(),
    balanceCycles: result.balanceCycles
  };
}

function parseActivateDatabaseInput(body: unknown): ActivateDatabaseInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("request body must be an object");
  }
  const record = body as Record<string, unknown>;
  return {
    databaseId: requiredText(record.databaseId, "databaseId"),
    purchaserPrincipal: requiredPrincipalText(record.purchaserPrincipal, "purchaserPrincipal"),
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
    "SELECT app_account_token, database_id, purchaser_principal, product_id, status, expires_at_ms, transaction_id FROM iap_purchase_intents WHERE app_account_token = ?1"
  )
    .bind(appAccountToken)
    .first<PurchaseIntentRow>();
}

async function validatePurchaseIntent(env: RuntimeEnv, input: { appAccountToken: string; databaseId: string; purchaserPrincipal: string; productId: string; transactionId: string }): Promise<void> {
  const intent = await purchaseIntentByToken(env, input.appAccountToken);
  if (!intent) {
    throw new Error("purchase intent not found");
  }
  if (intent.database_id !== input.databaseId) {
    throw new Error("purchase intent database mismatch");
  }
  if (intent.purchaser_principal !== input.purchaserPrincipal) {
    throw new Error("purchase intent purchaser mismatch");
  }
  if (intent.product_id !== input.productId) {
    throw new Error("purchase intent product mismatch");
  }
  if (intent.status === "fulfilled" && intent.transaction_id === input.transactionId) {
    return;
  }
  if (intent.status !== "created") {
    throw new Error("purchase intent is not active");
  }
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

async function markFulfillmentGranting(env: RuntimeEnv, input: { transactionId: string; databaseId: string; purchaserPrincipal: string; appAccountToken: string; productId: string; environment: string; bundleId: string; cycles: string }): Promise<FulfillmentRow | null> {
  const result = await env.DB.prepare(
    "UPDATE iap_fulfillments SET app_account_token = ?1, product_id = ?2, environment = ?3, bundle_id = ?4, cycles = ?5, status = 'granting', error_message = NULL, updated_at_ms = ?6 WHERE transaction_id = ?7 AND database_id = ?8 AND purchaser_principal = ?9 AND status IN ('received', 'failed', 'granting')"
  )
    .bind(input.appAccountToken, input.productId, input.environment, input.bundleId, input.cycles, Date.now(), input.transactionId, input.databaseId, input.purchaserPrincipal)
    .run();
  if ((result.meta.changes ?? 0) !== 1) {
    const fulfillment = await fulfillmentByTransaction(env, input.transactionId);
    if (fulfillment?.status === "fulfilled") return fulfillment;
    throw new Error("fulfillment state changed before granting");
  }
  return null;
}

async function finalizeFulfillment(env: RuntimeEnv, input: { transactionId: string; databaseId: string; purchaserPrincipal: string; appAccountToken: string; productId: string }): Promise<void> {
  const now = Date.now();
  try {
    const results = await env.DB.batch([
      env.DB.prepare(
        "UPDATE iap_fulfillments SET status = 'fulfilled', error_message = NULL, updated_at_ms = ?1 WHERE transaction_id = ?2 AND database_id = ?3 AND purchaser_principal = ?4 AND app_account_token = ?5 AND status = 'granting'"
      ).bind(now, input.transactionId, input.databaseId, input.purchaserPrincipal, input.appAccountToken),
      env.DB.prepare(
        "UPDATE iap_purchase_intents SET status = 'fulfilled', transaction_id = ?1, updated_at_ms = ?2 WHERE app_account_token = ?3 AND database_id = ?4 AND purchaser_principal = ?5 AND product_id = ?6 AND (status = 'created' OR (status = 'fulfilled' AND transaction_id = ?1))"
      ).bind(input.transactionId, now, input.appAccountToken, input.databaseId, input.purchaserPrincipal, input.productId)
    ]);
    if (results.some((result) => (result.meta.changes ?? 0) !== 1)) {
      throw new Error("state mismatch");
    }
  } catch (error) {
    throw new Error(`D1 finalization failed: ${errorMessage(error)}`);
  }
}

async function markFulfillmentFailed(env: RuntimeEnv, transactionId: string, message: string): Promise<void> {
  await env.DB.prepare("UPDATE iap_fulfillments SET status = 'failed', error_message = ?1, updated_at_ms = ?2 WHERE transaction_id = ?3 AND status = 'granting'")
    .bind(message, Date.now(), transactionId)
    .run();
}

function fulfilledActivationResponse(fulfillment: FulfillmentRow, input: ActivateDatabaseInput, deviceAppAccountToken: string | null): Record<string, string | boolean> {
  assertFulfillmentOwner(fulfillment, input.databaseId, input.purchaserPrincipal, "fulfilled");
  if (!deviceAppAccountToken || !fulfillment.app_account_token || deviceAppAccountToken !== fulfillment.app_account_token) {
    throw new Error("transaction already fulfilled for another purchase intent");
  }
  return {
    fulfilled: true,
    transactionId: fulfillment.transaction_id,
    databaseId: fulfillment.database_id,
    productId: fulfillment.product_id,
    cycles: fulfillment.cycles
  };
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

function isRetryableActivationError(message: string): boolean {
  return message.startsWith("VFS grant failed:") || message.startsWith("D1 finalization failed:");
}
