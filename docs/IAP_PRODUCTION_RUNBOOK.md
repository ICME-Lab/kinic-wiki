# IAP release acceptance

Use the maintained [Payment Worker guide](../workers/payment/README.md) for
configuration, guarded deployment commands and notification endpoints, and the
[iOS TestFlight guide](../mobile/ios/README.md#testflight) for upload behavior.
Product IDs and grant amounts come from the reviewed payment catalog; release
versions come from the intended iOS release, not a historical runbook.

## Before release

- Fix the reviewed source revision and identify the current canister, authorities,
  ledger, D1 database and App Store app/product. Confirm the dedicated authority
  backup is encrypted, recoverable and matches the configured principal.
- Compare the running canister interface/schema with the Worker requirements.
  Upgrade only if required, using a separately reviewed migration and recovery
  procedure. `scripts/mainnet/deploy_wiki.sh` is a frozen IAP backport script with
  branch/base/module-hash guards, not a general upgrade command. Do not bypass
  its guards to deploy a later release.
- Run the payment tests, type checks and production configuration guard. Keep
  Sandbox fulfillment disabled except during an explicitly bounded review window;
  retain the configured lifetime cap. Verify notification delivery and rejection
  paths before exposing purchases.

## Purchase acceptance

For a physical-device purchase, correlate the Apple transaction, D1 fulfillment,
canister audit and ledger entry. Verify exactly one grant of the catalog amount
to the selected database. Replay must not grant twice; a transaction cannot be
reused for another DB, product, purchaser or amount. Record the result without
publishing credentials or transaction payloads in source control.

## Distribution and recovery

Select the intended marketing version and verify the processed build's version,
number and production endpoints. Follow the upload script's current build-number
rules. For the first consumable review, associate the intended IAP and app build;
do not copy old App Store version identifiers. Restore Sandbox fulfillment to
disabled after the review window and verify the Production transaction path.

After any successful grant, do not restore a pre-grant canister snapshot: that
would diverge from Apple transactions and the cycles ledger. Stop fulfillment
and fix forward if needed. Refund/revoke notifications are audit-only and do not
automatically reverse grants; review those records operationally.
