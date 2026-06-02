#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARTIFACT_DIR="$ROOT_DIR/.icp/cache/e2e-ii"
BACKEND_WASM_GZ="$ARTIFACT_DIR/internet_identity_dev.wasm.gz"
BACKEND_WASM="$ARTIFACT_DIR/internet_identity_dev.wasm"
FRONTEND_WASM_GZ="$ARTIFACT_DIR/internet_identity_frontend.wasm.gz"
FRONTEND_WASM="$ARTIFACT_DIR/internet_identity_frontend.wasm"
BACKEND_CANISTER_ID_FILE="$ARTIFACT_DIR/backend_canister_id"
FRONTEND_CANISTER_ID_FILE="$ARTIFACT_DIR/frontend_canister_id"
LEGACY_CANISTER_ID_FILE="$ARTIFACT_DIR/canister_id"
ENV_FILE="$ROOT_DIR/wikibrowser/.env.e2e.local"
MAPPING_FILE="$ROOT_DIR/.icp/cache/mappings/local-wiki.ids.json"
II_RELEASE="${II_RELEASE:-release-2026-05-08}"
II_BACKEND_WASM_URL="${II_BACKEND_WASM_URL:-https://github.com/dfinity/internet-identity/releases/download/$II_RELEASE/internet_identity_dev.wasm.gz}"
II_FRONTEND_WASM_URL="${II_FRONTEND_WASM_URL:-https://github.com/dfinity/internet-identity/releases/download/$II_RELEASE/internet_identity_frontend.wasm.gz}"
II_BACKEND_INIT_ARGS='(opt record { captcha_config = opt record { max_unsolved_captchas= 50:nat64; captcha_trigger = variant {Static = variant {CaptchaDisabled}}}; dummy_auth = opt opt record { prompt_for_index = false }; is_production = opt false })'

mkdir -p "$ARTIFACT_DIR"

ensure_canister_id() {
  local id_file="$1"
  if [ -s "$id_file" ]; then
    local canister_id
    canister_id="$(tr -d '[:space:]' < "$id_file")"
    if icp canister status "$canister_id" -e local-wiki >/dev/null 2>&1; then
      return
    fi
  fi
  icp canister create --detached -e local-wiki --quiet > "$id_file"
}

if [ ! -s "$BACKEND_WASM_GZ" ]; then
  curl -fsSL "$II_BACKEND_WASM_URL" -o "$BACKEND_WASM_GZ"
fi

if [ ! -s "$FRONTEND_WASM_GZ" ]; then
  curl -fsSL "$II_FRONTEND_WASM_URL" -o "$FRONTEND_WASM_GZ"
fi

if [ ! -s "$BACKEND_WASM" ] || [ "$BACKEND_WASM_GZ" -nt "$BACKEND_WASM" ]; then
  gzip -dc "$BACKEND_WASM_GZ" > "$BACKEND_WASM"
fi

if [ ! -s "$FRONTEND_WASM" ] || [ "$FRONTEND_WASM_GZ" -nt "$FRONTEND_WASM" ]; then
  gzip -dc "$FRONTEND_WASM_GZ" > "$FRONTEND_WASM"
fi

if [ ! -s "$BACKEND_CANISTER_ID_FILE" ] && [ -s "$LEGACY_CANISTER_ID_FILE" ]; then
  cp "$LEGACY_CANISTER_ID_FILE" "$BACKEND_CANISTER_ID_FILE"
fi

ensure_canister_id "$BACKEND_CANISTER_ID_FILE"
ensure_canister_id "$FRONTEND_CANISTER_ID_FILE"

II_BACKEND_CANISTER_ID="$(tr -d '[:space:]' < "$BACKEND_CANISTER_ID_FILE")"
II_FRONTEND_CANISTER_ID="$(tr -d '[:space:]' < "$FRONTEND_CANISTER_ID_FILE")"
WIKI_CANISTER_ID="$(node -e 'const fs=require("fs"); const file=process.argv[1]; const ids=JSON.parse(fs.readFileSync(file,"utf8")); if(!ids.wiki) throw new Error("wiki canister id is missing"); process.stdout.write(ids.wiki);' "$MAPPING_FILE")"
II_FRONTEND_INIT_ARGS="$(printf '(record { backend_canister_id = principal "%s"; backend_origin = "http://%s.raw.localhost:8011"; related_origins = null; fetch_root_key = opt true; analytics_config = null; dummy_auth = opt opt record { prompt_for_index = false }; dev_csp = opt true })' "$II_BACKEND_CANISTER_ID" "$II_BACKEND_CANISTER_ID")"

if ! icp canister install "$II_BACKEND_CANISTER_ID" \
    -e local-wiki \
    --mode reinstall \
    --wasm "$BACKEND_WASM" \
    --args "$II_BACKEND_INIT_ARGS" \
    -y; then
  icp canister create --detached -e local-wiki --quiet > "$BACKEND_CANISTER_ID_FILE"
  II_BACKEND_CANISTER_ID="$(tr -d '[:space:]' < "$BACKEND_CANISTER_ID_FILE")"
  II_FRONTEND_INIT_ARGS="$(printf '(record { backend_canister_id = principal "%s"; backend_origin = "http://%s.raw.localhost:8011"; related_origins = null; fetch_root_key = opt true; analytics_config = null; dummy_auth = opt opt record { prompt_for_index = false }; dev_csp = opt true })' "$II_BACKEND_CANISTER_ID" "$II_BACKEND_CANISTER_ID")"
  icp canister install "$II_BACKEND_CANISTER_ID" \
    -e local-wiki \
    --mode reinstall \
    --wasm "$BACKEND_WASM" \
    --args "$II_BACKEND_INIT_ARGS" \
    -y
fi

if ! icp canister install "$II_FRONTEND_CANISTER_ID" \
    -e local-wiki \
    --mode reinstall \
    --wasm "$FRONTEND_WASM" \
    --args "$II_FRONTEND_INIT_ARGS" \
    -y; then
  icp canister create --detached -e local-wiki --quiet > "$FRONTEND_CANISTER_ID_FILE"
  II_FRONTEND_CANISTER_ID="$(tr -d '[:space:]' < "$FRONTEND_CANISTER_ID_FILE")"
  icp canister install "$II_FRONTEND_CANISTER_ID" \
    -e local-wiki \
    --mode reinstall \
    --wasm "$FRONTEND_WASM" \
    --args "$II_FRONTEND_INIT_ARGS" \
    -y
fi

{
  printf 'NEXT_PUBLIC_WIKI_IC_HOST=http://127.0.0.1:8011\n'
  printf 'NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID=%s\n' "$WIKI_CANISTER_ID"
  printf 'NEXT_PUBLIC_II_PROVIDER_URL=http://%s.raw.localhost:8011\n' "$II_FRONTEND_CANISTER_ID"
} > "$ENV_FILE"

printf 'Wrote %s\n' "$ENV_FILE"
printf 'NEXT_PUBLIC_KINIC_WIKI_CANISTER_ID=%s\n' "$WIKI_CANISTER_ID"
printf 'NEXT_PUBLIC_II_PROVIDER_URL=http://%s.raw.localhost:8011\n' "$II_FRONTEND_CANISTER_ID"
