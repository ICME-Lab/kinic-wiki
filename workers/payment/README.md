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
  - verifies App Store Server Notification V2 `signedPayload` against Apple's published root certificate allowlist, then stores refund/revoke audit payloads.

## Required Bindings

- D1 binding: `DB`
- Rate Limiting binding `IAP_GLOBAL_RATE_LIMITER`: 300 requests per 60 seconds, keyed by endpoint
- Rate Limiting binding `IAP_PRINCIPAL_RATE_LIMITER`: 10 requests per 60 seconds, keyed by endpoint and purchaser principal
- `KINIC_WIKI_CANISTER_ID`
- `KINIC_IAP_AUTHORITY_ID`: principal derived from the dedicated authority PEM
- `KINIC_IAP_AUTHORITY_IDENTITY_PEM`
- `APP_STORE_ISSUER_ID`
- `APP_STORE_KEY_ID`
- `APP_STORE_PRIVATE_KEY_PEM`
- `APP_STORE_BUNDLE_ID`
- `APP_STORE_ALLOWED_ENVIRONMENTS`: comma-separated allowlist of `Sandbox` and/or `Production`
- `APP_STORE_SANDBOX_FULFILLMENT_ENABLED`: whether verified Sandbox purchases may reserve a grant
- `APP_STORE_SANDBOX_GRANT_LIMIT`: maximum lifetime Sandbox grant reservations in this D1 database
- `APP_STORE_NOTIFICATION_ROOT_SHA256S`: comma-separated SHA-256 allowlist for Apple's published root certificates
- `IAP_PRODUCT_CATALOG_JSON`: JSON object mapping product IDs to cycle amounts
- optional `KINIC_WIKI_IC_HOST`

`IAP_PRODUCT_CATALOG_JSON` is authoritative. iOS never sends an amount.

The grant for `xyz.kinic.dbcredits.small` is fixed at `2,000,000,000,000` cycles
for each `$4.99` purchase. It does not vary with the XDR/USD exchange rate. The
production record is approved from the App Store Connect `$4.99` readback.
Existing purchase intents keep their stored amount snapshot when the
catalog changes; only newly created intents receive the current fixed amount.

## Deployment

`wrangler.jsonc` is a local/dev config and intentionally does not bind `payment.kinic.xyz`.

The committed `wrangler.sandbox.jsonc` is isolated to `kinic-payment-sandbox`, the staging
VFS canister, a dedicated D1 database name, and dedicated Rate Limiting namespaces. Before
the first deployment, create the D1 database with Wrangler's `--update-config` and apply both
migrations remotely. Store the IAP identity PEM and Apple credentials only with
`wrangler secret put`; never write them to a file in this repository. Apple root fingerprints
are public trust anchors committed in the Worker configuration.

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

The production Worker can verify both `Sandbox` and `Production`: TestFlight produces Sandbox
transactions, while the App Store release produces Production transactions. The Worker uses the
device transaction environment only to choose Apple's API endpoint, then requires Apple's verified
transaction to report the same allowed environment. Sandbox fulfillment is disabled by default in
production. It may be enabled only for a bounded TestFlight or App Review window, and the production
guard caps the lifetime Sandbox grant count at 10.

Fill the IAP authority principal, `database_id`, and both Rate Limiting `namespace_id`
placeholders with production IDs. The Worker rejects the PEM at runtime if its derived principal
does not equal `KINIC_IAP_AUTHORITY_ID`.
Set secrets with `wrangler secret put` for `KINIC_IAP_AUTHORITY_IDENTITY_PEM`,
`APP_STORE_ISSUER_ID`, `APP_STORE_KEY_ID`, and `APP_STORE_PRIVATE_KEY_PEM`.

Then deploy with:

```bash
pnpm --filter kinic-payment-worker check:production:example
pnpm --filter kinic-payment-worker deploy
```

Production deployment is blocked until the non-secret price record in `operations/` is
marked approved with the App Store CLI readback timestamp.

### Production promotion order

1. Confirm the Paid Apps Agreement is active and approve the recorded `$4.99` price for the
   fixed `2,000,000,000,000` cycle grant.
2. Create the production D1 database and Rate Limiting namespaces, copy the example config to
   the ignored `wrangler.production.jsonc`, replace all resource ID placeholders, and apply D1
   migrations remotely.
3. Store all four production secrets listed above. Keep the IAP authority identity separate
   from the billing authority.
4. From the clean `feat/iap-mainnet-backport` worktree, run
   `scripts/mainnet/deploy_wiki.sh` for a read-only preflight. After reviewing its build,
   set the exact confirmation value printed by the script and rerun with `--execute`. Verify that
   `get_cycles_billing_config` returns it before exposing the Worker.
5. Run the production deploy guard, deploy the Worker, and smoke-test both purchase-intent and
   activation error paths before enabling purchases in the app.
6. For App Review only, set `APP_STORE_SANDBOX_FULFILLMENT_ENABLED` to `true`, keep the committed
   grant limit, deploy, and monitor the bounded Sandbox reservations. Normal TestFlight QA uses the
   isolated `--sandbox` build instead.
7. Configure both App Store Server Notification V2 URLs to
   `https://payment.kinic.xyz/iap/app-store-notifications` and send Apple's test notifications.
8. Upload the `1.0.4` build. Submit the first consumable together with that new app version.
9. After App Review completes, restore `APP_STORE_SANDBOX_FULFILLMENT_ENABLED=false` and redeploy.

Refund and revoke notifications are verified and retained for audit. They do not currently
reverse a cycle grant automatically, so production operations must review those records.

## Verification

```bash
pnpm --filter kinic-payment-worker typecheck
pnpm --filter kinic-payment-worker cf-typecheck
pnpm --filter kinic-payment-worker test
```
