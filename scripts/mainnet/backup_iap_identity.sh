#!/usr/bin/env bash
set -euo pipefail

# Where: scripts/mainnet/backup_iap_identity.sh
# What: Create and verify the encrypted offline backup for the production IAP identity.
# Why: The Worker secret alone is not a recoverable operator backup.

IDENTITY_NAME="kinic-iap-production"
EXPECTED_PRINCIPAL="hcums-tc6dw-saet6-tkznz-mkldy-lwq47-2pehv-uoq3u-6a22c-mqfsh-5qe"
BACKUP_DIR="${KINIC_IAP_BACKUP_DIR:-/Users/0xhude/Documents/Kinic Secrets}"
BACKUP_PATH="${BACKUP_DIR}/kinic-iap-production.pem.gpg"

if [[ -e "${BACKUP_PATH}" ]]; then
  echo "refusing to overwrite existing backup: ${BACKUP_PATH}" >&2
  exit 1
fi
for command in icp gpg cmp; do
  if ! command -v "${command}" >/dev/null 2>&1; then
    echo "required command is unavailable: ${command}" >&2
    exit 1
  fi
done

principal="$(icp identity principal --identity "${IDENTITY_NAME}")"
if [[ "${principal}" != "${EXPECTED_PRINCIPAL}" ]]; then
  echo "unexpected ${IDENTITY_NAME} principal: ${principal}" >&2
  exit 1
fi

plain_path="$(mktemp /private/tmp/kinic-iap-production.XXXXXX.pem)"
verify_path="$(mktemp /private/tmp/kinic-iap-production-verify.XXXXXX.pem)"
backup_verified=0
cleanup() {
  rm -P "${plain_path}" "${verify_path}" 2>/dev/null || rm -f "${plain_path}" "${verify_path}"
  if [[ "${backup_verified}" != "1" ]]; then
    rm -f "${BACKUP_PATH}"
  fi
}
trap cleanup EXIT

mkdir -p "${BACKUP_DIR}"
icp identity export "${IDENTITY_NAME}" >"${plain_path}"
chmod 600 "${plain_path}"
gpg --symmetric --cipher-algo AES256 --output "${BACKUP_PATH}" "${plain_path}"
chmod 600 "${BACKUP_PATH}"
gpg --quiet --decrypt --output "${verify_path}" "${BACKUP_PATH}"
cmp "${plain_path}" "${verify_path}"
backup_verified=1

echo "encrypted IAP identity backup verified: ${BACKUP_PATH}"
