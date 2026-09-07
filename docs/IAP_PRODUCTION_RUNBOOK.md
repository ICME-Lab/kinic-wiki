# IAP Production Runbook

This runbook promotes the fixed `xyz.kinic.dbcredits.small` product at `$4.99`
for `2,000,000,000,000` database cycles. Git commits, production deploys, App
Store Connect mutations, and manual App Store release remain explicit operator
actions.

## Fixed production identities

- VFS canister: `6emaw-iyaaa-aaaay-aacka-cai`
- Expected pre-upgrade module hash:
  `184c5eea473b84fd12346129f10ee41fb2580ff7cc1a90997a2ea0e5bb461c0a`
- Controller and billing authority:
  `r75h6-lqd7b-5jack-at55d-vvti2-lg5qy-ly73a-5ezve-odnkc-kagu3-nae`
- Cycles ledger: `73mez-iiaaa-aaaaq-aaasq-cai`
- IAP authority:
  `hcums-tc6dw-saet6-tkznz-mkldy-lwq47-2pehv-uoq3u-6a22c-mqfsh-5qe`
- App Store app ID: `6785718977`
- IAP ID: `6807698664`
- IAP version ID: `3b719894-60df-4161-a213-1f316883349f`

Stop if any identity, controller, ledger, or module hash differs. Do not adapt
the command to an unexpected live state during the release window.

## 1. Prepare the two commits

Commit the normal iOS and Payment Worker branch first. Separately review and
commit the `feat/iap-mainnet-backport` worktree based on `83bbb0b6`. Do not
cherry-pick the mixed mainline IAP commit into the backport.

Back up the dedicated authority identity from an interactive terminal:

```bash
scripts/mainnet/backup_iap_identity.sh
```

Confirm that `/Users/0xhude/Documents/Kinic Secrets/kinic-iap-production.pem.gpg`
exists, has mode `0600`, decrypts to the expected principal, and that no plain
PEM remains beside it.

## 2. Upgrade the VFS canister

From the clean `feat/iap-mainnet-backport` worktree:

```bash
scripts/mainnet/deploy_wiki.sh
```

Review every printed live value and the built Wasm. The preflight validates the
frozen live Candid and performs no network mutation. Only after it succeeds:

```bash
CONFIRM_MAINNET_IAP_UPGRADE=6emaw-iyaaa-aaaay-aacka-cai \
  scripts/mainnet/deploy_wiki.sh --execute
```

The execute path creates and records a canister snapshot before using explicit
`upgrade` mode. It rejects `reinstall`. Afterward confirm migration
`database_index:004_iap_cycle_grants`, unchanged existing data and billing
settings, the configured optional IAP authority, and rejection of a grant from
any other caller.

Do not restore a pre-grant snapshot after a successful grant. If a defect is
found after fulfillment begins, disable the Worker route and fix forward so
the canister ledger and Apple transactions remain consistent.

## 3. Deploy the Payment Worker closed

Keep `APP_STORE_SANDBOX_FULFILLMENT_ENABLED=false` and
`APP_STORE_SANDBOX_GRANT_LIMIT=10`. From a clean committed branch run:

```bash
pnpm --filter kinic-payment-worker check:production:example
pnpm --filter kinic-payment-worker typecheck
pnpm --filter kinic-payment-worker cf-typecheck
pnpm --filter kinic-payment-worker test
pnpm --filter kinic-payment-worker deploy
```

Confirm `payment.kinic.xyz` resolves to the deployed Worker. Smoke-test a valid
purchase-intent request, an invalid activation request, and the notification
endpoint. The invalid activation must not create a fulfillment or grant.

Set both Production and Sandbox App Store Server Notification V2 URLs to:

```text
https://payment.kinic.xyz/iap/app-store-notifications
```

Send Apple's test notification and confirm one verified D1 audit row.

## 4. Perform the bounded Sandbox grant

Change only `APP_STORE_SANDBOX_FULFILLMENT_ENABLED` to `true`, retain the
lifetime limit of 10, re-run the production guard, and redeploy. Make one
purchase on a physical device.

Record the Apple transaction ID and verify all of the following before
continuing:

- exactly one fulfilled D1 row exists for that transaction;
- exactly one canister IAP audit and cycles-ledger row exists;
- the selected database balance increased by exactly
  `2,000,000,000,000` cycles;
- replaying the same transaction does not change the balance;
- a transaction cannot be reused for another database, product, purchaser, or
  amount.

## 5. Stage App Store version 1.0.4

Unlock and connect the physical device and complete the signed tests first.
Upload with the explicit marketing version and without a local build-number
override so the script must select the App Store Connect latest build plus one:

```bash
KINIC_IOS_BUILD_NUMBER= \
  KINIC_IOS_MARKETING_VERSION=1.0.4 \
  ASC_PROFILE=DreamVault \
  mobile/ios/scripts/testflight-upload.sh --external
```

Wait for processing, then enable external TestFlight only after confirming the
build reports version `1.0.4`, the new build number, production payment origin,
and no export-compliance issue.

Create App Store version `1.0.4` with manual release. Attach that build and IAP
version `3b719894-60df-4161-a213-1f316883349f` to the same review submission.
Do not submit the IAP alone.

## 6. Review and release

During review keep Sandbox fulfillment enabled with the lifetime limit of 10.
Monitor fulfillment and notification audits. After approval, set Sandbox
fulfillment back to `false`, pass the production guard, redeploy, and verify a
Production transaction path before manually releasing version `1.0.4`.

Refund and revoke notifications are audit-only and do not reverse previously
granted cycles. Review those rows operationally.
