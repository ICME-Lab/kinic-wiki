# Review Notes

## Test account and access

The extension requires Internet Identity and writer access to a Kinic Wiki database. For review, provide a test Internet Identity flow or a reviewer database with writer access before submission.

## Primary flows

1. Open extension options.
2. Login with Internet Identity.
3. Select a writable Kinic Wiki database.
4. Open any `http` or `https` page and click the extension action.
5. Confirm that a URL ingest request is created in the selected database.
6. Open `https://chatgpt.com`, click the Kinic Wiki Clipper page control, and start export.

## Notes for reviewers

- The extension does not inject UI outside ChatGPT pages.
- The extension rejects non-web pages such as `chrome://extensions`.
- ChatGPT export uses the user's existing ChatGPT browser session and starts only after user action.
- URL ingest uses a short-lived session nonce authorized by the Kinic Wiki canister.
