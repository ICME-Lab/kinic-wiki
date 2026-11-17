# Shared Wiki and Vault UI

Pure React editor, Markdown, Button/Input and class utilities, plus the common stylesheet and Tailwind preset. Both apps own their content scan paths and rendering policy. Wiki keeps its existing facade imports. Vault supplies non-submit/no-autofill defaults and private Markdown components; `unstyled` forwards the caller’s exact class string without applying Wiki widget styling.

This package must not import application code, authentication, actors, private-session state, networking, persistence or AI. `scripts/check-vault-boundary.mjs` checks those boundaries. The shared stylesheet preserves existing light-only behavior and dormant dark tokens; sharing it does not enable a new theme feature.
