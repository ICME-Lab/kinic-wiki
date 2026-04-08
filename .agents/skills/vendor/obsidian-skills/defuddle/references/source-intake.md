# Source Intake

Use cleaned web content as input material for wiki generation.

## Recommended flow

1. extract readable content from the page
2. keep the original URL and page title
3. decide whether the result should become:
   - a `source_summary`
   - a supporting source for another page
4. synthesize into the local working copy instead of copying raw text directly

## Avoid

- treating web extraction output as final truth
- pushing low-signal raw dumps into the wiki
- losing provenance back to the source URL
