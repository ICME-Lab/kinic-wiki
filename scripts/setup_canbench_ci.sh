#!/usr/bin/env bash
set -euo pipefail

# Where: scripts/setup_canbench_ci.sh
# What: Install a fixed canbench CLI and PocketIC runtime into repo-local ignored paths.
# Why: canbench 0.4.1 requires pocket-ic-server 10.0.0, so CI must provision those exact versions before the guard script runs.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CANBENCH_ROOT="${REPO_ROOT}/.canbench-tools"
CANBENCH_BIN="${CANBENCH_ROOT}/bin/canbench"
POCKET_IC_DIR="${REPO_ROOT}/.canbench"
POCKET_IC_BIN="${POCKET_IC_DIR}/pocket-ic"
CANBENCH_VERSION="0.4.1"
POCKET_IC_VERSION="10.0.0"

detect_platform_suffix() {
  local os
  local arch
  os="$(uname -s)"
  arch="$(uname -m)"

  case "${os}" in
    Linux) os="linux" ;;
    Darwin) os="darwin" ;;
    *)
      echo "unsupported OS for PocketIC download: ${os}" >&2
      return 1
      ;;
  esac

  case "${arch}" in
    x86_64|amd64) arch="x86_64" ;;
    arm64|aarch64) arch="arm64" ;;
    *)
      echo "unsupported architecture for PocketIC download: ${arch}" >&2
      return 1
      ;;
  esac

  printf '%s-%s\n' "${arch}" "${os}"
}

mkdir -p "${CANBENCH_ROOT}" "${POCKET_IC_DIR}"

if [[ ! -x "${CANBENCH_BIN}" ]]; then
  cargo install \
    --root "${CANBENCH_ROOT}" \
    --version "${CANBENCH_VERSION}" \
    --locked \
    canbench
fi

PLATFORM_SUFFIX="$(detect_platform_suffix)"
POCKET_IC_URL="https://github.com/dfinity/pocketic/releases/download/${POCKET_IC_VERSION}/pocket-ic-${PLATFORM_SUFFIX}.gz"

if [[ ! -x "${POCKET_IC_BIN}" ]]; then
  # Release asset delivery can return transient 5xx responses. Download to a
  # file so curl can restart cleanly instead of appending retries to a pipe.
  curl -fsSL --retry 3 --retry-delay 2 "${POCKET_IC_URL}" -o "${POCKET_IC_BIN}.gz"
  gzip -dc "${POCKET_IC_BIN}.gz" > "${POCKET_IC_BIN}"
  rm "${POCKET_IC_BIN}.gz"
  chmod +x "${POCKET_IC_BIN}"
fi

INSTALLED_CANBENCH_VERSION="$("${CANBENCH_BIN}" --version | awk '{print $2}')"
INSTALLED_POCKET_IC_VERSION="$("${POCKET_IC_BIN}" --version)"

if [[ "${INSTALLED_CANBENCH_VERSION}" != "${CANBENCH_VERSION}" ]]; then
  echo "canbench version mismatch: got ${INSTALLED_CANBENCH_VERSION}, expected ${CANBENCH_VERSION}" >&2
  exit 1
fi

if [[ "${INSTALLED_POCKET_IC_VERSION}" != "pocket-ic-server ${POCKET_IC_VERSION}" ]]; then
  echo "PocketIC version mismatch: got ${INSTALLED_POCKET_IC_VERSION}, expected pocket-ic-server ${POCKET_IC_VERSION}" >&2
  exit 1
fi

echo "Installed canbench ${INSTALLED_CANBENCH_VERSION} at ${CANBENCH_BIN}"
echo "Installed ${INSTALLED_POCKET_IC_VERSION} at ${POCKET_IC_BIN}"
