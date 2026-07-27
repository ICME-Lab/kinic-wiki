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
