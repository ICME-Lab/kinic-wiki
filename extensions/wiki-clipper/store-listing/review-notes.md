# Review Notes

## Test account and access

The extension requires Internet Identity and writer access to a Kinic Wiki database. For review, provide a test Internet Identity flow or a reviewer database with writer access before submission.

## Primary flows

1. Open extension options.
2. Login with Internet Identity.
3. Select a writable Kinic Wiki database.
4. Open any `http` or `https` page and click the extension action.
5. Confirm that a web snapshot is saved under `/Sources/web/...` in the selected database.
6. Open `https://chatgpt.com`, click the Kinic Wiki Clipper page control, and start export.
7. Open `https://claude.ai`, click the Kinic Wiki Clipper page control, and start export.
8. Open `https://gemini.google.com`, open a conversation, click `Save to Kinic`, and start export.
9. In extension options, enable `Recall beta`, open a ChatGPT conversation, send a test question, and confirm that related previews appear only when the selected database contains matching content.

## Notes for reviewers

- The extension injects export UI only on ChatGPT, Claude, and Gemini pages.
- The extension rejects non-web pages such as `chrome://extensions`.
- ChatGPT/Claude/Gemini export uses the user's existing browser session and starts only after user action. Gemini capture reads the rendered current conversation DOM and does not call a Gemini history API.
- Source generation uses a short-lived session nonce returned by the Kinic Wiki canister.
- Recall is read-only, disabled by default, does not save the submitted question, and never auto-sends inserted context.
