# App Store Screenshot Assets

`screenshots.json` is the source of truth for order, captions, device sizes, and raw PNG capture names.
The renderer combines each real app capture with the KinicWiki caption treatment.

Place ten public-safe captures under:

```text
mobile/ios/build/AppStoreScreenshots/raw/
  iphone/01-organized.png
  iphone/02-save-from-safari.png
  iphone/03-lasting-knowledge.png
  iphone/04-ask-with-sources.png
  iphone/05-under-control.png
  ipad/01-organized.png
  ipad/02-save-from-safari.png
  ipad/03-lasting-knowledge.png
  ipad/04-ask-with-sources.png
  ipad/05-under-control.png
```

Prepare the database and nodes from `demo-content.md`, then render:

```bash
pnpm ios:store-screenshots
```

The command fails if an input is missing, if the manifest does not contain exactly five scenes, or if a generated PNG has the wrong dimensions or an alpha channel. Outputs are written to `mobile/ios/build/AppStoreScreenshots/output/` and remain untracked.

## Optional voice preview release gate

The preview is disabled in the bundle and server by default. Before enabling it, review App Privacy answers against actual OpenAI/Cloudflare transmission and retention of questions, audio and Wiki excerpts, identity-linked service-credit billing records, and provider deletion behavior. Confirm the existing DB credits IAP description covers optional AI connection time. Existing text QA/history and the optional preview have different processing; do not describe all Ask AI requests as first-party-only. Never claim ZDR or instantaneous provider erasure. Live pricing, release dates and device/background acceptance remain pending.
