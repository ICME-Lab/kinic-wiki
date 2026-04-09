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
    "/usr"
    "/opt/homebrew/opt/wasi-libc/share/wasi-sysroot"
    "/usr/local/opt/wasi-libc/share/wasi-sysroot"
  )

  for candidate in "${candidates[@]}"; do
    if wasi_sysroot_exists "${candidate}"; then
      printf '%s\n' "${candidate}"
      return 0
    fi
  done

  return 1
}

wasi_sysroot_exists() {
  local sysroot="${1}"

  if [[ -d "${sysroot}/include" ]]; then
    return 0
  fi

  if [[ -d "${sysroot}/include/wasm32-wasip1" || -d "${sysroot}/include/wasm32-wasi" ]]; then
    return 0
  fi

  return 1
}

resolve_wasi_include_dir() {
  local sysroot="${1}"

  if [[ -d "${sysroot}/include/wasm32-wasip1" ]]; then
    printf '%s\n' "${sysroot}/include/wasm32-wasip1"
    return 0
  fi

  if [[ -d "${sysroot}/include/wasm32-wasi" ]]; then
    printf '%s\n' "${sysroot}/include/wasm32-wasi"
    return 0
  fi

  if [[ -d "${sysroot}/include" ]]; then
    printf '%s\n' "${sysroot}/include"
    return 0
  fi

  return 1
}

configure_wasi_cc_env() {
  local sysroot
  local include_dir
  local cflags

  if ! sysroot="$(resolve_wasi_sysroot)"; then
    return 0
  fi

  export WASI_SYSROOT="${sysroot}"
  export CC_wasm32_wasip1="${CC_wasm32_wasip1:-clang}"
  cflags="${CFLAGS_wasm32_wasip1:-} --sysroot=${sysroot}"

  if include_dir="$(resolve_wasi_include_dir "${sysroot}")"; then
    cflags="${cflags} -isystem ${include_dir}"
  fi

  export CFLAGS_wasm32_wasip1="${cflags# }"
}
