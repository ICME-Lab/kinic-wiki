#!/usr/bin/env bash
set -euo pipefail

# Where: scripts/wasi-env.sh
# What: Resolve and export WASI sysroot settings for C dependencies built for wasm32-wasip1.
# Why: cc-rs needs an explicit sysroot on Linux CI when bundled sqlite is compiled for the canister target.

resolve_wasi_sysroot() {
  local candidate
  local -a candidates=()

  if [[ -n "${WASI_SYSROOT:-}" ]]; then
    candidates+=("${WASI_SYSROOT}")
  fi
  if [[ -n "${WASI_SDK_PATH:-}" ]]; then
    candidates+=("${WASI_SDK_PATH}/share/wasi-sysroot")
    candidates+=("${WASI_SDK_PATH}/share/wasi-sysroot/..")
  fi
  candidates+=(
    "/usr/share/wasi-sysroot"
    "/opt/homebrew/opt/wasi-libc/share/wasi-sysroot"
    "/usr/local/opt/wasi-libc/share/wasi-sysroot"
  )

  for candidate in "${candidates[@]}"; do
    if [[ -d "${candidate}/include" ]]; then
      printf '%s\n' "${candidate}"
      return 0
    fi
  done

  return 1
}

configure_wasi_cc_env() {
  local sysroot
  if ! sysroot="$(resolve_wasi_sysroot)"; then
    return 0
  fi

  export WASI_SYSROOT="${sysroot}"
  export CC_wasm32_wasip1="${CC_wasm32_wasip1:-clang}"
  export CFLAGS_wasm32_wasip1="${CFLAGS_wasm32_wasip1:-} --sysroot=${sysroot}"
}
