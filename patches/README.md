# Candid Text BOM preservation

`@icp-sdk__core-bom.patch` applies to the workspace's SDK 5.4.0 and 6.0.0.
Candid Text is a string, so a leading U+FEFF is content. The SDK's default
TextDecoder strips it; `ignoreBOM: true` preserves it. Both ESM and CommonJS
TextClass implementations are patched; `fatal: true` stays enabled. No global
decoder override or custom Candid parser is used.

Keep the pnpm workspace patch and lockfile together. Remove the patch only when
the upstream versions in use pass `workers/wiki-mcp/tests/candid-text.test.ts`
without it. The PocketIC integration also checks the actual product reader
against the real canister's Candid reply through its local live gateway.

# Picomatch repeated-extglob backport

`picomatch@2.3.2.patch` and `picomatch@4.0.7.patch` address
[GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf)
in every resolved copy. Repeating a branch containing an unbounded wildcard,
including a single branch such as `+(*a)`, creates nested regex quantifiers.
The existing safety analysis now treats these unsimplified branches as risky
and matches them literally. Its existing safe nested-star rewrites remain.
Escaped/quoted stars and recognized character classes retain their meaning;
unknown POSIX class names follow the parser's actual closing-bracket behavior.
The upstream explicit `maxExtglobRecursion: false` opt-out is unchanged; no
workspace consumers enable it.

Run `pnpm test:dependency-patches` after a frozen installation. It checks every
locked copy's patch hash and exercises the installed Vite, Vitest, micromatch,
anymatch and readdirp copies with bounded subprocess attack tests and ordinary
glob controls. CI runs this gate in the always-enabled configuration job.

The registry audit still reports the original package versions because it cannot
inspect local patch contents. The matching audit exclusion represents this
backport, rather than an unpatched dependency. Keep the patches, hash/behavior
gate and audit entry together. Recheck by 2026-12-02 and remove this backport and
its audit entry when an upstream release passes these regression tests without
the patches. New resolved versions require review and fail the gate meanwhile.
