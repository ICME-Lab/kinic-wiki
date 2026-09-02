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

The current `xyz.kinic.dbcredits.small` template grant is `1,825,000,000,000` cycles.
This is the 1B-cycle-floor of `($4.99 / 2) / 1.366430 XDR per USD`, using the published
reference rate only for the pre-approval calculation. Recompute and record the
XDR/USD rate when the App Store price is approved, then update the catalog before
selling. Keep the product's cycles value immutable after an intent is created; each
intent stores its own amount snapshot.

## Deployment

`wrangler.jsonc` is a local/dev config and intentionally does not bind `payment.kinic.xyz`.

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

## Verification

```bash
pnpm --filter kinic-payment-worker typecheck
pnpm --filter kinic-payment-worker cf-typecheck
pnpm --filter kinic-payment-worker test
```
