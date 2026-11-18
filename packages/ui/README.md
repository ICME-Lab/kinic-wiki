# Shared Wiki and Vault UI

Pure React editor, Markdown, Button/Input, status pills, cycle balances, empty states and class utilities, plus the common stylesheet and Tailwind preset. Both apps own their content scan paths and rendering policy. Wiki keeps its existing facade imports. Vault supplies non-submit/no-autofill defaults and private Markdown components. Vault uses the common button and input styling; `unstyled` remains available for callers that supply their own presentation. Cycle balance colours and billing decisions are supplied by each app.

This package must not import application code, authentication, actors, private-session state, networking, persistence or AI. `scripts/check-vault-boundary.mjs` checks those boundaries. The shared stylesheet preserves existing light-only behavior and dormant dark tokens; sharing it does not enable a new theme feature.

Both top-up screens use `PaymentForm` from `@kinic/ui/payment-form`; the shared form composes `FundingSource` and `PaymentStatus`. The form accepts plain display values and action callbacks. Its callers provide the selected funding account, credit target, exact KINIC fees, confirmed terms, progress and available recovery actions. An acknowledged approval fee appears as paid alongside the remaining debit.

Sensitive editor hosts must register `sensitiveCleanup` with their session and synchronously wipe the editor on lock. Wiping removes visible text and editor history; it does not reset the host's React state. The host must also discard private state and unmount/remount the editor before reuse (for example, key it by the session generation). Reusing a wiped instance with stale controlled content can restore secrets.
