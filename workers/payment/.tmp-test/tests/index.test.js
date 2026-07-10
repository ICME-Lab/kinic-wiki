// Where: workers/payment/tests/index.test.ts
// What: IAP activation fulfillment tests.
// Why: Payment idempotency and server-owned product catalog must stay deterministic.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sign, X509Certificate } from "node:crypto";
import test from "node:test";
import worker from "../src/index.js";
import { activateDatabase, createPaymentWorker, createPurchaseIntent } from "../src/index.js";
import { base64Url, base64UrlJson } from "../src/jws.js";
const DATABASE_ID = "db_abc";
const PRINCIPAL = "r7inp-6aaaa-aaaaa-aaabq-cai";
const PRODUCT_ID = "xyz.kinic.dbcredits.small";
test("valid transaction grants catalog cycles and marks fulfillment", async () => {
    const env = await testEnv();
    const appAccountToken = await purchaseIntent(env);
    const transactionJWS = jws({ transactionId: "tx-1", appAccountToken });
    const response = await activateDatabase(env, {
        databaseId: DATABASE_ID,
        purchaserPrincipal: PRINCIPAL,
        transactionJWS
    }, async (_env, request) => {
        assert.equal(request.amountCycles, 12345n);
        assert.equal(request.externalPaymentId, "tx-1");
        assert.equal(request.productId, "xyz.kinic.dbcredits.small");
        return { blockIndex: "0", amountCycles: "12345", balanceCycles: "12345" };
    }, fakeAppStoreFetch(jws(serverPayload("tx-1", { appAccountToken }))));
    assert.deepEqual(response, {
        fulfilled: true,
        transactionId: "tx-1",
        databaseId: DATABASE_ID,
        productId: PRODUCT_ID,
        cycles: "12345",
        balanceCycles: "12345"
    });
    assert.equal(env.DB.rows.get("tx-1")?.status, "fulfilled");
    assert.equal(env.DB.intents.get(appAccountToken)?.status, "fulfilled");
});
test("purchase intent endpoint creates UUID token for known product", async () => {
    const env = await testEnv();
    const response = await worker.fetch(new Request("https://payment.test/iap/purchase-intents", {
        method: "POST",
        body: JSON.stringify({ databaseId: DATABASE_ID, purchaserPrincipal: PRINCIPAL, productId: PRODUCT_ID }),
        headers: { "content-type": "application/json" }
    }), env);
    const body = (await response.json());
    assert.equal(response.status, 200);
    assert.match(body.appAccountToken, /^[0-9a-f-]{36}$/u);
    assert.equal(env.DB.intents.get(body.appAccountToken)?.database_id, DATABASE_ID);
});
test("purchase intent endpoint rejects unknown product", async () => {
    const env = await testEnv();
    const response = await worker.fetch(new Request("https://payment.test/iap/purchase-intents", {
        method: "POST",
        body: JSON.stringify({ databaseId: DATABASE_ID, purchaserPrincipal: PRINCIPAL, productId: "unknown.product" }),
        headers: { "content-type": "application/json" }
    }), env);
    assert.equal(response.status, 400);
});
test("global rate limit returns 429 before D1 writes", async () => {
    const env = await testEnv();
    env.IAP_GLOBAL_RATE_LIMITER.outcome = "deny";
    const response = await worker.fetch(new Request("https://payment.test/iap/purchase-intents", {
        method: "POST",
        body: JSON.stringify({ databaseId: DATABASE_ID, purchaserPrincipal: PRINCIPAL, productId: PRODUCT_ID })
    }), env);
    assert.equal(response.status, 429);
    assert.deepEqual(env.IAP_GLOBAL_RATE_LIMITER.keys, ["iap:purchase-intents"]);
    assert.equal(env.IAP_PRINCIPAL_RATE_LIMITER.keys.length, 0);
    assert.equal(env.DB.intents.size, 0);
    assert.equal(env.DB.rows.size, 0);
});
test("principal rate limit returns 429 before D1 writes", async () => {
    const env = await testEnv();
    env.IAP_PRINCIPAL_RATE_LIMITER.outcome = "deny";
    const response = await worker.fetch(new Request("https://payment.test/iap/activate-database", {
        method: "POST",
        body: JSON.stringify({
            databaseId: DATABASE_ID,
            purchaserPrincipal: PRINCIPAL,
            transactionJWS: jws({ transactionId: "tx-rate-limited", appAccountToken: crypto.randomUUID() })
        })
    }), env);
    assert.equal(response.status, 429);
    assert.deepEqual(env.IAP_GLOBAL_RATE_LIMITER.keys, ["iap:activate-database"]);
    assert.deepEqual(env.IAP_PRINCIPAL_RATE_LIMITER.keys, [`iap:activate-database:${PRINCIPAL}`]);
    assert.equal(env.DB.intents.size, 0);
    assert.equal(env.DB.rows.size, 0);
});
test("rate limiter failure returns 503 and fails closed", async () => {
    const env = await testEnv();
    env.IAP_GLOBAL_RATE_LIMITER.outcome = "throw";
    const response = await worker.fetch(new Request("https://payment.test/iap/purchase-intents", {
        method: "POST",
        body: JSON.stringify({ databaseId: DATABASE_ID, purchaserPrincipal: PRINCIPAL, productId: PRODUCT_ID })
    }), env);
    assert.equal(response.status, 503);
    assert.equal(env.DB.intents.size, 0);
    assert.equal(env.DB.rows.size, 0);
});
test("local HTTP E2E fulfills a database credit purchase and retries idempotently", async () => {
    const env = await testEnv();
    const transactionId = "tx-http-e2e";
    let appAccountToken = "";
    let grantCount = 0;
    const e2eWorker = createPaymentWorker({
        fetcher: async () => new Response(JSON.stringify({ signedTransactionInfo: jws(serverPayload(transactionId, { appAccountToken })) }), {
            status: 200,
            headers: { "content-type": "application/json" }
        }),
        grant: async (_env, request) => {
            grantCount += 1;
            assert.equal(request.databaseId, DATABASE_ID);
            assert.equal(request.purchaserPrincipal, PRINCIPAL);
            assert.equal(request.externalPaymentId, transactionId);
            assert.equal(request.productId, PRODUCT_ID);
            assert.equal(request.amountCycles, 12345n);
            return { blockIndex: "0", amountCycles: "12345", balanceCycles: "12345" };
        }
    });
    const intentResponse = await e2eWorker.fetch(new Request("https://payment.test/iap/purchase-intents", {
        method: "POST",
        body: JSON.stringify({ databaseId: DATABASE_ID, purchaserPrincipal: PRINCIPAL, productId: PRODUCT_ID }),
        headers: { "content-type": "application/json" }
    }), env);
    const intentBody = (await intentResponse.json());
    appAccountToken = intentBody.appAccountToken;
    const transactionJWS = jws({ transactionId, appAccountToken });
    const activateRequestBody = JSON.stringify({ databaseId: DATABASE_ID, purchaserPrincipal: PRINCIPAL, transactionJWS });
    const activateResponse = await e2eWorker.fetch(new Request("https://payment.test/iap/activate-database", {
        method: "POST",
        body: activateRequestBody,
        headers: { "content-type": "application/json" }
    }), env);
    const activation = (await activateResponse.json());
    const retryResponse = await e2eWorker.fetch(new Request("https://payment.test/iap/activate-database", {
        method: "POST",
        body: activateRequestBody,
        headers: { "content-type": "application/json" }
    }), env);
    const retryActivation = (await retryResponse.json());
    assert.equal(intentResponse.status, 200);
    assert.equal(activateResponse.status, 200);
    assert.equal(retryResponse.status, 200);
    assert.deepEqual(activation, {
        fulfilled: true,
        transactionId,
        databaseId: DATABASE_ID,
        productId: PRODUCT_ID,
        cycles: "12345",
        balanceCycles: "12345"
    });
    assert.deepEqual(retryActivation, {
        fulfilled: true,
        transactionId,
        databaseId: DATABASE_ID,
        productId: PRODUCT_ID,
        cycles: "12345"
    });
    assert.equal(grantCount, 1);
    assert.equal(env.DB.rows.get(transactionId)?.status, "fulfilled");
    assert.equal(env.DB.intents.get(appAccountToken)?.status, "fulfilled");
});
test("duplicate fulfilled transaction returns without another grant", async () => {
    const env = await testEnv();
    const appAccountToken = crypto.randomUUID();
    env.DB.rows.set("tx-2", {
        transaction_id: "tx-2",
        database_id: DATABASE_ID,
        purchaser_principal: PRINCIPAL,
        app_account_token: appAccountToken,
        product_id: PRODUCT_ID,
        environment: "Sandbox",
        bundle_id: "xyz.kinic.ios.KinicWiki",
        cycles: "12345",
        status: "fulfilled"
    });
    const response = await activateDatabase(env, {
        databaseId: DATABASE_ID,
        purchaserPrincipal: PRINCIPAL,
        transactionJWS: jws({ transactionId: "tx-2", appAccountToken })
    }, async () => {
        throw new Error("grant should not run");
    }, fakeAppStoreFetch(jws(serverPayload("tx-2", { appAccountToken }))));
    assert.equal(response.fulfilled, true);
    assert.equal(response.transactionId, "tx-2");
});
test("fulfilled duplicate rejects another purchase intent token", async () => {
    const env = await testEnv();
    env.DB.rows.set("tx-fulfilled-token", {
        transaction_id: "tx-fulfilled-token",
        database_id: DATABASE_ID,
        purchaser_principal: PRINCIPAL,
        app_account_token: crypto.randomUUID(),
        product_id: PRODUCT_ID,
        environment: "Sandbox",
        bundle_id: "xyz.kinic.ios.KinicWiki",
        cycles: "12345",
        status: "fulfilled"
    });
    await assert.rejects(activateDatabase(env, {
        databaseId: DATABASE_ID,
        purchaserPrincipal: PRINCIPAL,
        transactionJWS: jws({ transactionId: "tx-fulfilled-token", appAccountToken: crypto.randomUUID() })
    }, async () => {
        throw new Error("grant should not run");
    }, fakeAppStoreFetch(jws(serverPayload("tx-fulfilled-token", { appAccountToken: crypto.randomUUID() })))), /another purchase intent/);
});
test("duplicate transaction for another database does not overwrite fulfillment row", async () => {
    const env = await testEnv();
    const appAccountToken = await purchaseIntent(env);
    env.DB.rows.set("tx-conflict", {
        transaction_id: "tx-conflict",
        database_id: "db_other",
        purchaser_principal: PRINCIPAL,
        app_account_token: null,
        product_id: "unknown",
        environment: "Sandbox",
        bundle_id: "xyz.kinic.ios.KinicWiki",
        cycles: "0",
        status: "received"
    });
    await assert.rejects(activateDatabase(env, {
        databaseId: DATABASE_ID,
        purchaserPrincipal: PRINCIPAL,
        transactionJWS: jws({ transactionId: "tx-conflict", appAccountToken })
    }, async () => {
        throw new Error("grant should not run");
    }, fakeAppStoreFetch(jws(serverPayload("tx-conflict", { appAccountToken })))), /another database/);
    assert.equal(env.DB.rows.get("tx-conflict")?.database_id, "db_other");
});
test("unknown product rejects before grant", async () => {
    const env = await testEnv();
    const appAccountToken = await purchaseIntent(env);
    await assert.rejects(activateDatabase(env, {
        databaseId: DATABASE_ID,
        purchaserPrincipal: PRINCIPAL,
        transactionJWS: jws({ transactionId: "tx-3", appAccountToken })
    }, async () => {
        throw new Error("grant should not run");
    }, fakeAppStoreFetch(jws(serverPayload("tx-3", { productId: "unknown.product", appAccountToken })))), /unknown IAP product/);
});
test("failed App Store verification does not reserve the transaction id", async () => {
    const env = await testEnv();
    const appAccountToken = await purchaseIntent(env);
    const transactionJWS = jws({ transactionId: "tx-verify-retry", appAccountToken });
    const grant = async () => ({
        blockIndex: "0",
        amountCycles: "12345",
        balanceCycles: "12345"
    });
    await assert.rejects(activateDatabase(env, { databaseId: DATABASE_ID, purchaserPrincipal: PRINCIPAL, transactionJWS }, grant, fakeAppStoreFetch(jws(serverPayload("different-transaction", { appAccountToken })))), /transaction id mismatch/);
    assert.equal(env.DB.rows.has("tx-verify-retry"), false);
    const activation = await activateDatabase(env, { databaseId: DATABASE_ID, purchaserPrincipal: PRINCIPAL, transactionJWS }, grant, fakeAppStoreFetch(jws(serverPayload("tx-verify-retry", { appAccountToken }))));
    assert.equal(activation.fulfilled, true);
    assert.equal(env.DB.rows.get("tx-verify-retry")?.status, "fulfilled");
});
test("revoked transaction rejects before grant", async () => {
    const env = await testEnv();
    const appAccountToken = await purchaseIntent(env);
    await assert.rejects(activateDatabase(env, {
        databaseId: DATABASE_ID,
        purchaserPrincipal: PRINCIPAL,
        transactionJWS: jws({ transactionId: "tx-revoked", appAccountToken })
    }, async () => {
        throw new Error("grant should not run");
    }, fakeAppStoreFetch(jws(serverPayload("tx-revoked", { appAccountToken, revocationDate: "1710000000000" })))), /revoked/);
});
test("bundle and environment mismatch reject before grant", async () => {
    const env = await testEnv();
    const bundleToken = await purchaseIntent(env);
    await assert.rejects(activateDatabase(env, {
        databaseId: DATABASE_ID,
        purchaserPrincipal: PRINCIPAL,
        transactionJWS: jws({ transactionId: "tx-bundle", appAccountToken: bundleToken })
    }, async () => {
        throw new Error("grant should not run");
    }, fakeAppStoreFetch(jws(serverPayload("tx-bundle", { appAccountToken: bundleToken, bundleId: "wrong.bundle" })))), /bundle id mismatch/);
    const envToken = await purchaseIntent(env);
    await assert.rejects(activateDatabase(env, {
        databaseId: DATABASE_ID,
        purchaserPrincipal: PRINCIPAL,
        transactionJWS: jws({ transactionId: "tx-env", appAccountToken: envToken })
    }, async () => {
        throw new Error("grant should not run");
    }, fakeAppStoreFetch(jws(serverPayload("tx-env", { appAccountToken: envToken, environment: "Production" })))), /environment mismatch/);
});
test("VFS failure leaves failed fulfillment for retry", async () => {
    const env = await testEnv();
    const appAccountToken = await purchaseIntent(env);
    await assert.rejects(activateDatabase(env, {
        databaseId: DATABASE_ID,
        purchaserPrincipal: PRINCIPAL,
        transactionJWS: jws({ transactionId: "tx-4", appAccountToken })
    }, async () => {
        throw new Error("canister unavailable");
    }, fakeAppStoreFetch(jws(serverPayload("tx-4", { appAccountToken })))), /VFS grant failed: canister unavailable/);
    assert.equal(env.DB.rows.get("tx-4")?.status, "failed");
});
test("D1 finalization failure remains retryable after canister grant", async () => {
    const env = await testEnv();
    const appAccountToken = await purchaseIntent(env);
    const transactionJWS = jws({ transactionId: "tx-finalize", appAccountToken });
    let grantCount = 0;
    const grant = async () => {
        grantCount += 1;
        return { blockIndex: "0", amountCycles: "12345", balanceCycles: "12345" };
    };
    env.DB.failNextBatch = true;
    await assert.rejects(activateDatabase(env, {
        databaseId: DATABASE_ID,
        purchaserPrincipal: PRINCIPAL,
        transactionJWS
    }, grant, fakeAppStoreFetch(jws(serverPayload("tx-finalize", { appAccountToken })))), /D1 finalization failed/);
    assert.equal(env.DB.rows.get("tx-finalize")?.status, "granting");
    assert.equal(env.DB.intents.get(appAccountToken)?.status, "created");
    const response = await activateDatabase(env, {
        databaseId: DATABASE_ID,
        purchaserPrincipal: PRINCIPAL,
        transactionJWS
    }, grant, fakeAppStoreFetch(jws(serverPayload("tx-finalize", { appAccountToken }))));
    assert.equal(response.fulfilled, true);
    assert.equal(grantCount, 2);
    assert.equal(env.DB.rows.get("tx-finalize")?.status, "fulfilled");
    assert.equal(env.DB.intents.get(appAccountToken)?.status, "fulfilled");
});
test("fulfilled purchase intent for same transaction can be finalized on retry", async () => {
    const env = await testEnv();
    const appAccountToken = await purchaseIntent(env);
    const intent = env.DB.intents.get(appAccountToken);
    if (!intent)
        throw new Error("intent missing");
    intent.status = "fulfilled";
    intent.transaction_id = "tx-intent-fulfilled";
    env.DB.rows.set("tx-intent-fulfilled", {
        transaction_id: "tx-intent-fulfilled",
        database_id: DATABASE_ID,
        purchaser_principal: PRINCIPAL,
        app_account_token: appAccountToken,
        product_id: PRODUCT_ID,
        environment: "Sandbox",
        bundle_id: "xyz.kinic.ios.KinicWiki",
        cycles: "12345",
        status: "granting"
    });
    const response = await activateDatabase(env, {
        databaseId: DATABASE_ID,
        purchaserPrincipal: PRINCIPAL,
        transactionJWS: jws({ transactionId: "tx-intent-fulfilled", appAccountToken })
    }, async () => ({ blockIndex: "0", amountCycles: "12345", balanceCycles: "12345" }), fakeAppStoreFetch(jws(serverPayload("tx-intent-fulfilled", { appAccountToken }))));
    assert.equal(response.fulfilled, true);
    assert.equal(env.DB.rows.get("tx-intent-fulfilled")?.status, "fulfilled");
});
test("activation rejects missing or mismatched purchase intent token", async () => {
    const env = await testEnv();
    await assert.rejects(activateDatabase(env, {
        databaseId: DATABASE_ID,
        purchaserPrincipal: PRINCIPAL,
        transactionJWS: jws({ transactionId: "tx-missing-token" })
    }, async () => {
        throw new Error("grant should not run");
    }, fakeAppStoreFetch(jws(serverPayload("tx-missing-token")))), /appAccountToken is required/);
    const appAccountToken = await purchaseIntent(env, { databaseId: "db_other" });
    await assert.rejects(activateDatabase(env, {
        databaseId: DATABASE_ID,
        purchaserPrincipal: PRINCIPAL,
        transactionJWS: jws({ transactionId: "tx-wrong-db", appAccountToken })
    }, async () => {
        throw new Error("grant should not run");
    }, fakeAppStoreFetch(jws(serverPayload("tx-wrong-db", { appAccountToken })))), /purchase intent database mismatch/);
});
test("activation accepts expired intent when verified transaction matches it", async () => {
    const env = await testEnv();
    const expiredToken = await purchaseIntent(env);
    const expired = env.DB.intents.get(expiredToken);
    if (!expired)
        throw new Error("expired intent missing");
    expired.expires_at_ms = Date.now() - 1;
    const response = await activateDatabase(env, {
        databaseId: DATABASE_ID,
        purchaserPrincipal: PRINCIPAL,
        transactionJWS: jws({ transactionId: "tx-expired", appAccountToken: expiredToken })
    }, async () => ({ blockIndex: "0", amountCycles: "12345", balanceCycles: "12345" }), fakeAppStoreFetch(jws(serverPayload("tx-expired", { appAccountToken: expiredToken }))));
    assert.equal(response.fulfilled, true);
    assert.equal(env.DB.rows.get("tx-expired")?.status, "fulfilled");
    assert.equal(env.DB.intents.get(expiredToken)?.status, "fulfilled");
});
test("activation rejects product-mismatched purchase intents", async () => {
    const env = await testEnv();
    const productToken = await purchaseIntent(env);
    const productMismatch = env.DB.intents.get(productToken);
    if (!productMismatch)
        throw new Error("product mismatch intent missing");
    productMismatch.product_id = "other.product";
    await assert.rejects(activateDatabase(env, {
        databaseId: DATABASE_ID,
        purchaserPrincipal: PRINCIPAL,
        transactionJWS: jws({ transactionId: "tx-product-mismatch", appAccountToken: productToken })
    }, async () => {
        throw new Error("grant should not run");
    }, fakeAppStoreFetch(jws(serverPayload("tx-product-mismatch", { appAccountToken: productToken })))), /purchase intent product mismatch/);
});
test("App Store notification rejects unsigned payload", async () => {
    const env = await testEnv();
    const signedPayload = jws({
        notificationUUID: "notification-fake",
        notificationType: "REFUND",
        data: {
            signedTransactionInfo: jws(serverPayload("tx-refund", { appAccountToken: crypto.randomUUID() }))
        }
    });
    const response = await worker.fetch(new Request("https://payment.test/iap/app-store-notifications", {
        method: "POST",
        body: JSON.stringify({ signedPayload }),
        headers: { "content-type": "application/json" }
    }), env);
    assert.equal(response.status, 400);
    assert.equal(env.DB.notifications.size, 0);
});
test("App Store notification stores verified refund or revoke payload", async () => {
    const env = await testEnv();
    const notificationUUID = "notification-1";
    const fixture = signedNotificationFixture();
    const signedTransactionInfo = signFixtureJws(fixture, serverPayload("tx-refund", { appAccountToken: crypto.randomUUID() }));
    const signedPayload = signFixtureJws(fixture, {
        notificationUUID,
        notificationType: "REFUND",
        subtype: "VOLUNTARY",
        data: {
            bundleId: "xyz.kinic.ios.KinicWiki",
            environment: "Sandbox",
            signedTransactionInfo
        }
    });
    env.APP_STORE_NOTIFICATION_ROOT_SHA256 = fixture.rootFingerprint;
    const response = await worker.fetch(new Request("https://payment.test/iap/app-store-notifications", {
        method: "POST",
        body: JSON.stringify({ signedPayload }),
        headers: { "content-type": "application/json" }
    }), env);
    assert.equal(response.status, 200);
    assert.equal(env.DB.notifications.get(notificationUUID), "REFUND");
});
test("App Store notification rejects outer bundle or environment mismatch", async () => {
    const env = await testEnv();
    const fixture = signedNotificationFixture();
    const signedTransactionInfo = signFixtureJws(fixture, serverPayload("tx-notification-outer", { appAccountToken: crypto.randomUUID() }));
    const signedPayload = signFixtureJws(fixture, {
        notificationUUID: "notification-outer-mismatch",
        notificationType: "REFUND",
        data: {
            bundleId: "wrong.bundle",
            environment: "Sandbox",
            signedTransactionInfo
        }
    });
    env.APP_STORE_NOTIFICATION_ROOT_SHA256 = fixture.rootFingerprint;
    const response = await worker.fetch(new Request("https://payment.test/iap/app-store-notifications", {
        method: "POST",
        body: JSON.stringify({ signedPayload }),
        headers: { "content-type": "application/json" }
    }), env);
    assert.equal(response.status, 400);
    assert.equal(env.DB.notifications.size, 0);
});
test("App Store notification rejects nested transaction bundle or environment mismatch", async () => {
    const env = await testEnv();
    const fixture = signedNotificationFixture();
    const signedTransactionInfo = signFixtureJws(fixture, serverPayload("tx-notification-nested", { appAccountToken: crypto.randomUUID(), environment: "Production" }));
    const signedPayload = signFixtureJws(fixture, {
        notificationUUID: "notification-nested-mismatch",
        notificationType: "REFUND",
        data: {
            bundleId: "xyz.kinic.ios.KinicWiki",
            environment: "Sandbox",
            signedTransactionInfo
        }
    });
    env.APP_STORE_NOTIFICATION_ROOT_SHA256 = fixture.rootFingerprint;
    const response = await worker.fetch(new Request("https://payment.test/iap/app-store-notifications", {
        method: "POST",
        body: JSON.stringify({ signedPayload }),
        headers: { "content-type": "application/json" }
    }), env);
    assert.equal(response.status, 400);
    assert.equal(env.DB.notifications.size, 0);
});
async function testEnv() {
    return {
        DB: new MemoryD1(),
        IAP_GLOBAL_RATE_LIMITER: new TestRateLimit(),
        IAP_PRINCIPAL_RATE_LIMITER: new TestRateLimit(),
        KINIC_WIKI_CANISTER_ID: "6emaw-iyaaa-aaaay-aacka-cai",
        KINIC_WIKI_IC_HOST: "https://icp0.io",
        KINIC_IAP_AUTHORITY_IDENTITY_PEM: "unused",
        APP_STORE_ENVIRONMENT: "Sandbox",
        APP_STORE_BUNDLE_ID: "xyz.kinic.ios.KinicWiki",
        APP_STORE_ISSUER_ID: "issuer",
        APP_STORE_KEY_ID: "key",
        APP_STORE_PRIVATE_KEY_PEM: await p256PrivateKeyPem(),
        IAP_PRODUCT_CATALOG_JSON: JSON.stringify({ "xyz.kinic.dbcredits.small": "12345" })
    };
}
function fakeAppStoreFetch(signedTransactionInfo) {
    return async () => new Response(JSON.stringify({ signedTransactionInfo }), {
        status: 200,
        headers: { "content-type": "application/json" }
    });
}
function serverPayload(transactionId, overrides = {}) {
    return {
        transactionId,
        originalTransactionId: `original-${transactionId}`,
        productId: "xyz.kinic.dbcredits.small",
        bundleId: "xyz.kinic.ios.KinicWiki",
        environment: "Sandbox",
        ...overrides
    };
}
function jws(payload) {
    return `${base64UrlJson({ alg: "ES256" })}.${base64UrlJson(payload)}.signature`;
}
async function purchaseIntent(env, overrides = {}) {
    const intent = await createPurchaseIntent(env, {
        databaseId: overrides.databaseId ?? DATABASE_ID,
        purchaserPrincipal: overrides.purchaserPrincipal ?? PRINCIPAL,
        productId: overrides.productId ?? PRODUCT_ID
    });
    return intent.appAccountToken;
}
function signedNotificationFixture() {
    const directory = mkdtempSync(join(tmpdir(), "kinic-payment-notification-"));
    openssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "root.key"], directory);
    openssl(["req", "-x509", "-new", "-key", "root.key", "-sha256", "-days", "1", "-subj", "/CN=Kinic Test Root", "-out", "root.crt"], directory);
    openssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "leaf.key"], directory);
    openssl(["req", "-new", "-key", "leaf.key", "-subj", "/CN=Kinic Test Leaf", "-out", "leaf.csr"], directory);
    openssl(["x509", "-req", "-in", "leaf.csr", "-CA", "root.crt", "-CAkey", "root.key", "-CAcreateserial", "-out", "leaf.crt", "-days", "1", "-sha256"], directory);
    openssl(["x509", "-in", "root.crt", "-outform", "DER", "-out", "root.der"], directory);
    openssl(["x509", "-in", "leaf.crt", "-outform", "DER", "-out", "leaf.der"], directory);
    const rootDer = readFileSync(join(directory, "root.der"));
    const leafDer = readFileSync(join(directory, "leaf.der"));
    return {
        leafDerBase64: leafDer.toString("base64"),
        rootDerBase64: rootDer.toString("base64"),
        rootFingerprint: new X509Certificate(rootDer).fingerprint256.replaceAll(":", "").toLowerCase(),
        leafPrivateKeyPem: readFileSync(join(directory, "leaf.key"), "utf8")
    };
}
function signFixtureJws(fixture, payload) {
    const header = base64UrlJson({ alg: "ES256", x5c: [fixture.leafDerBase64, fixture.rootDerBase64] });
    const encodedPayload = base64UrlJson(payload);
    const signingInput = `${header}.${encodedPayload}`;
    const signature = sign("sha256", Buffer.from(signingInput), {
        key: fixture.leafPrivateKeyPem,
        dsaEncoding: "ieee-p1363"
    });
    return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
}
function openssl(args, cwd) {
    execFileSync("openssl", args, { cwd, stdio: "ignore" });
}
async function p256PrivateKeyPem() {
    const key = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", key.privateKey));
    let binary = "";
    for (const byte of pkcs8)
        binary += String.fromCharCode(byte);
    return `-----BEGIN PRIVATE KEY-----\n${btoa(binary)}\n-----END PRIVATE KEY-----`;
}
class MemoryD1 {
    rows = new Map();
    intents = new Map();
    notifications = new Map();
    failNextBatch = false;
    prepare(query) {
        return new MemoryStatement(this, query);
    }
    async batch(statements) {
        if (this.failNextBatch) {
            this.failNextBatch = false;
            throw new Error("forced batch failure");
        }
        const rows = new Map(this.rows);
        const intents = new Map(this.intents);
        const notifications = new Map(this.notifications);
        try {
            return await Promise.all(statements.map((statement) => statement.run()));
        }
        catch (error) {
            this.rows = rows;
            this.intents = intents;
            this.notifications = notifications;
            throw error;
        }
    }
}
class TestRateLimit {
    outcome = "allow";
    keys = [];
    async limit(options) {
        this.keys.push(options.key);
        if (this.outcome === "throw") {
            throw new Error("rate limiter unavailable");
        }
        return { success: this.outcome === "allow" };
    }
}
class MemoryStatement {
    db;
    query;
    values = [];
    constructor(db, query) {
        this.db = db;
        this.query = query;
    }
    bind(...values) {
        this.values = values;
        return this;
    }
    async first() {
        if (this.query.startsWith("SELECT transaction_id")) {
            return (this.db.rows.get(String(this.values[0])) ?? null);
        }
        if (this.query.startsWith("SELECT app_account_token")) {
            return (this.db.intents.get(String(this.values[0])) ?? null);
        }
        return null;
    }
    async run() {
        if (this.query.startsWith("INSERT INTO iap_fulfillments")) {
            if (this.db.rows.has(String(this.values[0]))) {
                return { success: true, meta: { changes: 0 } };
            }
            this.db.rows.set(String(this.values[0]), {
                transaction_id: String(this.values[0]),
                database_id: String(this.values[1]),
                purchaser_principal: String(this.values[2]),
                app_account_token: null,
                product_id: "unknown",
                environment: String(this.values[3]),
                bundle_id: String(this.values[4]),
                cycles: "0",
                status: "received",
                error_message: null
            });
            return { success: true, meta: { changes: 1 } };
        }
        if (this.query.startsWith("INSERT INTO iap_purchase_intents")) {
            this.db.intents.set(String(this.values[0]), {
                app_account_token: String(this.values[0]),
                database_id: String(this.values[1]),
                purchaser_principal: String(this.values[2]),
                product_id: String(this.values[3]),
                status: "created",
                expires_at_ms: Number(this.values[4]),
                transaction_id: null
            });
            return { success: true, meta: { changes: 1 } };
        }
        if (this.query.startsWith("UPDATE iap_purchase_intents SET status = 'fulfilled'")) {
            const row = this.db.intents.get(String(this.values[2]));
            if (row &&
                row.database_id === String(this.values[3]) &&
                row.purchaser_principal === String(this.values[4]) &&
                row.product_id === String(this.values[5]) &&
                (row.status === "created" || (row.status === "fulfilled" && row.transaction_id === String(this.values[0])))) {
                row.status = "fulfilled";
                row.transaction_id = String(this.values[0]);
                return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
        }
        if (this.query.startsWith("UPDATE iap_fulfillments SET app_account_token")) {
            const row = this.db.rows.get(String(this.values[6]));
            if (row &&
                row.database_id === String(this.values[7]) &&
                row.purchaser_principal === String(this.values[8]) &&
                ["received", "failed", "granting"].includes(row.status)) {
                row.app_account_token = String(this.values[0]);
                row.product_id = String(this.values[1]);
                row.environment = String(this.values[2]);
                row.bundle_id = String(this.values[3]);
                row.cycles = String(this.values[4]);
                row.status = "granting";
                row.error_message = null;
                return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
        }
        if (this.query.startsWith("UPDATE iap_fulfillments SET status = 'fulfilled'")) {
            const row = this.db.rows.get(String(this.values[1]));
            if (row &&
                row.database_id === String(this.values[2]) &&
                row.purchaser_principal === String(this.values[3]) &&
                row.app_account_token === String(this.values[4]) &&
                row.status === "granting") {
                row.status = "fulfilled";
                row.error_message = null;
                return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
        }
        if (this.query.startsWith("UPDATE iap_fulfillments SET status = 'failed'")) {
            const row = this.db.rows.get(String(this.values[2]));
            if (row && row.status === "granting") {
                row.status = "failed";
                row.error_message = String(this.values[0]);
                return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
        }
        if (this.query.startsWith("INSERT INTO app_store_notifications")) {
            this.db.notifications.set(String(this.values[0]), String(this.values[1]));
            return { success: true, meta: { changes: 1 } };
        }
        return { success: true, meta: { changes: 0 } };
    }
}
