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
