# Mainnet / TestFlight Release

Full stack release path for Kinic Wiki mainnet, Cloudflare Workers, and iOS TestFlight.

## Preconditions

- Current branch is reviewed and all intended files are committed by the release operator.
- `icp` is authenticated with the mainnet deploy identity.
- `wrangler whoami` shows the Cloudflare account that owns `kinic.xyz`.
- App Store Connect API key is available outside the repo:
  - `ASC_KEY_PATH`
  - `ASC_KEY_ID`
  - `ASC_ISSUER_ID`
- iOS build number is new in App Store Connect and greater than `1`.
- Production identifiers stay fixed:
  - wiki canister: `xis3j-paaaa-aaaai-axumq-cai`
  - web origin: `https://wiki.kinic.xyz`
  - IC host: `https://icp0.io`
  - Internet Identity: `https://id.ai/#authorize`
  - Apple app id: `AKN976G7AK.xyz.kinic.ios.KinicWiki`

## Preflight

Run local checks before touching production:

```bash
pnpm -C wikibrowser test
pnpm -C wikibrowser lint
pnpm -C wikibrowser typecheck
pnpm -C wikibrowser build
pnpm -C workers/wiki-generator test
pnpm -C workers/wiki-generator typecheck
pnpm -C workers/wiki-mcp test
pnpm -C workers/wiki-mcp typecheck
xcodebuild test -project mobile/ios/Kinic.xcodeproj -scheme Kinic -destination 'platform=iOS Simulator,name=iPhone 17,OS=26.5' CODE_SIGNING_ALLOWED=NO
```

Validate the mainnet wiki deploy wrapper without installing code:

```bash
scripts/mainnet/deploy_wiki.sh --dry-run
```

Validate TestFlight inputs without archiving or uploading:

```bash
KINIC_IOS_BUILD_NUMBER=<next-build-number> \
ASC_KEY_PATH=/path/to/AuthKey_<key-id>.p8 \
ASC_KEY_ID=<key-id> \
ASC_ISSUER_ID=<issuer-id> \
mobile/ios/scripts/testflight-upload.sh --validate-only
```

## Mainnet Deploy

Deploy the canister only when the canister diff requires a mainnet upgrade:

```bash
scripts/mainnet/deploy_wiki.sh
```

Prepare Cloudflare secrets before deploying Workers:

```bash
pnpm -C workers/wiki-generator exec wrangler secret put DEEPSEEK_API_KEY
pnpm -C workers/wiki-generator exec wrangler secret put KINIC_WIKI_WORKER_TOKEN
pnpm -C workers/wiki-generator exec wrangler secret put KINIC_WIKI_WORKER_IDENTITY_PEM
pnpm -C wikibrowser exec wrangler secret put DEEPSEEK_API_KEY
pnpm -C wikibrowser exec wrangler secret put KINIC_WIKI_WORKER_TOKEN
pnpm -C wikibrowser exec wrangler secret put KINIC_WIKI_LINK_PREVIEW_REGEN_TOKEN
```

Deploy Workers:

```bash
pnpm -C workers/wiki-generator deploy
pnpm -C wikibrowser deploy:production
```

`wikibrowser/wrangler.jsonc` and `workers/wiki-generator/wrangler.jsonc` must both point to `xis3j-paaaa-aaaai-axumq-cai` and `https://icp0.io`.

## Smoke

Confirm production web and Apple association:

```bash
curl -fsS https://wiki.kinic.xyz/.well-known/apple-app-site-association
curl -fsS https://wiki.kinic.xyz/native-auth >/dev/null
curl -fsS -X OPTIONS https://wiki.kinic.xyz/api/source-capture/trigger \
  -H 'origin: https://wiki.kinic.xyz' \
  -H 'access-control-request-method: POST' \
  -o /dev/null -w '%{http_code}\n'
```

The AASA response must include:

```text
AKN976G7AK.xyz.kinic.ios.KinicWiki
```

Confirm source-capture trigger reaches session verification instead of missing runtime config:

```bash
curl -sS -i -X POST https://wiki.kinic.xyz/api/source-capture/trigger \
  -H 'origin: https://wiki.kinic.xyz' \
  -H 'content-type: application/json' \
  --data '{"canisterId":"xis3j-paaaa-aaaai-axumq-cai","databaseId":"db_smoke","requestPath":"/Sources/source-capture-requests/smoke.md","sessionNonce":"smoke"}'
```

Expected result for this fake session is a non-503 JSON error from session verification.

Run public read smoke against a known public database:

```bash
pnpm -C wikibrowser smoke:public -- --base-url https://wiki.kinic.xyz --database-id <public-database-id> --path /Knowledge/<existing-file>.md
```

## TestFlight

Upload an internal-testing-only TestFlight build:

```bash
KINIC_IOS_BUILD_NUMBER=<next-build-number> \
ASC_KEY_PATH=/path/to/AuthKey_<key-id>.p8 \
ASC_KEY_ID=<key-id> \
ASC_ISSUER_ID=<issuer-id> \
mobile/ios/scripts/testflight-upload.sh
```

The script archives with production endpoints and uploads with `xcodebuild -exportArchive`.
It refuses empty credentials, non-numeric build numbers, and build number `1`.
It also verifies `PrivacyInfo.xcprivacy` exists in both the app and Share Extension archive before upload.

After Apple processes the build, install it through TestFlight and confirm:

- Sign in opens Internet Identity from `wiki.kinic.xyz`.
- Writable databases load.
- Database creation works.
- Share Extension saves a source-capture request without waiting for worker generation.
- Source-capture output appears after the worker processes the queued request.
