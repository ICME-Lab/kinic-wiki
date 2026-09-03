# Kinic Payment Worker

Payment Worker for iOS App Store IAP database credits.

The iOS endpoints are public and protected by Cloudflare Rate Limiting bindings. Clients must handle `429` as a retryable response. Binding failures return `503` and fail closed before D1 writes.

## Endpoints

- `POST /iap/activate-database`
  - request: `{ "transactionJWS": "..." }`
  - verifies the App Store transaction, resolves its `appAccountToken` to the server-owned purchase intent, resolves `productId` from `IAP_PRODUCT_CATALOG_JSON`, grants DB cycles through `grant_database_cycles_from_iap`, then returns `fulfilled`.
- `POST /iap/purchase-intents`
  - request: `{ "databaseId": "...", "purchaserPrincipal": "...", "productId": "..." }`
  - response: `{ "appAccountToken": "..." }`; iOS passes this UUID to StoreKit with `.appAccountToken(...)`.
- `POST /iap/app-store-notifications`
  - verifies App Store Server Notification V2 `signedPayload` with the pinned Apple root fingerprint, then stores refund/revoke audit payloads.

## Required Bindings

- D1 binding: `DB`
- Rate Limiting binding `IAP_GLOBAL_RATE_LIMITER`: 300 requests per 60 seconds, keyed by endpoint
- Rate Limiting binding `IAP_PRINCIPAL_RATE_LIMITER`: 10 requests per 60 seconds, keyed by endpoint and purchaser principal
- `KINIC_WIKI_CANISTER_ID`
- `KINIC_IAP_AUTHORITY_IDENTITY_PEM`
- `APP_STORE_ISSUER_ID`
- `APP_STORE_KEY_ID`
- `APP_STORE_PRIVATE_KEY_PEM`
- `APP_STORE_BUNDLE_ID`
- `APP_STORE_ENVIRONMENT`: `Sandbox` or `Production`
- `APP_STORE_NOTIFICATION_ROOT_SHA256`: SHA-256 fingerprint for the pinned App Store notification root certificate
- `IAP_PRODUCT_CATALOG_JSON`: JSON object mapping product IDs to cycle amounts
- optional `KINIC_WIKI_IC_HOST`

`IAP_PRODUCT_CATALOG_JSON` is authoritative. iOS never sends an amount.

The grant for `xyz.kinic.dbcredits.small` is fixed at `2,000,000,000,000` cycles
for each `$4.99` purchase. It does not vary with the XDR/USD exchange rate. The
production record remains unapproved until the production price is approved and
read back. Existing purchase intents keep their stored amount snapshot when the
catalog changes; only newly created intents receive the current fixed amount.

## Deployment

`wrangler.jsonc` is a local/dev config and intentionally does not bind `payment.kinic.xyz`.

The committed `wrangler.sandbox.jsonc` is isolated to `kinic-payment-sandbox`, the staging
VFS canister, a dedicated D1 database name, and dedicated Rate Limiting namespaces. Before
the first deployment, create the D1 database with Wrangler's `--update-config` and apply both
migrations remotely. Store the IAP identity PEM, notification root fingerprint, and Apple
credentials only with `wrangler secret put`; never write them to a file in this repository.

```bash
pnpm --filter kinic-payment-worker check:sandbox
pnpm --filter kinic-payment-worker deploy:sandbox:dry-run
pnpm --filter kinic-payment-worker deploy:sandbox
```

The deployment command also requires a clean branch containing `origin/main`. The sandbox
catalog intentionally exposes only `xyz.kinic.dbcredits.small`.

Production deploy requires an explicit config:

```bash
cp workers/payment/wrangler.production.jsonc.example workers/payment/wrangler.production.jsonc
```

Fill `database_id` and both Rate Limiting `namespace_id` placeholders with production IDs, then set `APP_STORE_NOTIFICATION_ROOT_SHA256`.
Set secrets with `wrangler secret put` for `KINIC_IAP_AUTHORITY_IDENTITY_PEM`,
`APP_STORE_ISSUER_ID`, `APP_STORE_KEY_ID`, and `APP_STORE_PRIVATE_KEY_PEM`.

Then deploy with:

```bash
pnpm --filter kinic-payment-worker deploy
```

Production deployment is blocked until the non-secret price record in `operations/` is
marked approved with the App Store CLI readback timestamp and the approval-time IMF rate.

## Verification

```bash
pnpm --filter kinic-payment-worker typecheck
pnpm --filter kinic-payment-worker cf-typecheck
pnpm --filter kinic-payment-worker test
```
