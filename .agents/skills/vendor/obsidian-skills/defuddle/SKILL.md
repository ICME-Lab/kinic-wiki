---
name: defuddle
description: Extract clean markdown-oriented content from web pages before drafting wiki pages. Use when a URL or raw web page should be converted into readable source material with less clutter.
---

# Defuddle

This is a vendor-adapted skill derived from ideas in `kepano/obsidian-skills` and `kepano/defuddle`, narrowed for this repo.

Use this skill when the user provides:

- a URL to an article or documentation page
- a standard web page that should be converted into cleaner source material

## Role In This Repo

Use Defuddle-style extraction as a preprocessing step for `ingest`.

- extract readable content
- reduce clutter and navigation noise
- feed the cleaned content into page mapping and draft writing

Do not treat extracted markdown as final wiki content. It is source material.

## Guidance

- prefer markdown-oriented extraction
- keep the extracted source tied to its original URL and provenance
- synthesize before writing final wiki pages

Read [references/source-intake.md](references/source-intake.md) when using this with `ingest`.
