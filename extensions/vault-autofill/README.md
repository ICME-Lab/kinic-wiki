# Kinic Vault Chrome Extension (`extensions/vault-autofill`)

Manifest V3 Chrome extension for Kinic Vault — autofill logins, generate strong passwords/passphrases, save or update credentials, and copy live 2FA (TOTP) codes using the same encrypted Vault canister (`mcx4q-2qaaa-aaaao-qqn3a-cai`) as Kinic Vault Web (`https://vault.kinic.xyz`) and Kinic iOS.

## Origin & Identity Model

- **Calling origin**: `chrome-extension://dlbffglcocnllllhjaapackocgkaegak` (pinned via `manifest.json` `"key"`).
- **Derivation origin**: `https://mcx4q-2qaaa-aaaao-qqn3a-cai.icp0.io` (shared with Web and iOS via certified `/.well-known/ii-alternative-origins`).
- **Identity provider**: `https://id.ai`.
- **Wiki isolation**: Strictly isolated from Kinic Wiki (`wiki.kinic.xyz`, `6emaw-iyaaa-aaaay-aacka-cai`, `extensions/wiki-clipper`, `shared/ii-auth`).

## Development

```sh
pnpm --filter @kinic/vault-autofill-extension build
pnpm --filter @kinic/vault-autofill-extension typecheck
pnpm --filter @kinic/vault-autofill-extension test
```

Load `extensions/vault-autofill` as an unpacked extension in `chrome://extensions` (Developer Mode).

For local replica testing, create `extensions/vault-autofill/.env` with `VAULT_LOCAL_CANISTER_ID`, `VAULT_LOCAL_HOST`, `VAULT_LOCAL_II`, and `VAULT_LOCAL_ORIGIN`, then run:

```sh
pnpm --filter @kinic/vault-autofill-extension build:local
```

Load `extensions/vault-autofill/tmp/local-unpacked` in Chrome.
