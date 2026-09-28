# Recall Jev evaluation

New extension builds include Jev ranking when a database is selected, but a server-side threshold and API key are still required. Complete this evaluation and the staging checks before deploying the enabled configuration. Use one real Wiki database to prepare 60 human-labelled questions without ChatGPT conversation history: 45 with an answer in the Wiki, 15 with none. Assign 20 to `calibration` (15 positive, 5 negative) and 40 to `holdout` (30 positive, 10 negative). Freeze the holdout labels before running TypeSafe.

Save the cases outside the repository because paths and previews may contain private material. Each case has this shape:

```json
{
  "id": "case-001",
  "split": "calibration",
  "question": "Where is the release checklist?",
  "candidates": [
    { "path": "/Knowledge/release.md", "preview": "The release checklist is..." }
  ],
  "relevantPaths": ["/Knowledge/release.md"],
  "searchMs": 120
}
```

`candidates` must be the actual deduplicated Recall search results, in current ranking order, before the top-three cut and capped at 20. Exclude the current conversation. `searchMs` is the measured time to obtain those results. For a no-answer case, use `relevantPaths: []`. Keep the question and all previews out of CI artifacts and application logs.

With `TYPESAFE_API_KEY` set in the local process, run the opt-in paid evaluation:

```sh
node extensions/wiki-clipper/scripts/evaluate-recall-jev.mjs /private/path/recall-cases.json
```

The script chooses a threshold from the 20 calibration cases without reducing their Hit@3, then reports holdout Precision@3, Hit@3, false displays on the 10 no-answer cases, and an estimated retrieval-plus-Jev p95. The quality gate is Precision@3 at least 10 percentage points above the current method, Hit@3 no lower, and at most one false display. Measure the actual card-display p95 in the staging extension; it must be at most 4 seconds. The estimated p95 does not include browser rendering and is not sufficient by itself.

After the quality gate, configure the staging Worker with its own `TYPESAFE_API_KEY` secret and the measured `RECALL_JEV_THRESHOLD`, then build the staging extension. Both Jev switches now default to on; `KINIC_RECALL_JEV_ENABLED=false` in the extension `.env` or `RECALL_JEV_ENABLED=false` in the Worker configuration can disable ranking. Check submit display, conversation-switch stale result disposal, Add context, and failure fallback. Activate production only after these checks pass. Keep the extension bundle free of the API key.

The staging Recall endpoint is restricted to `db_moj6zr34uvmf` with `RECALL_ALLOWED_DATABASE_ID`. This is separate from the existing `KINIC_WIKI_ALLOWED_DATABASE_ID` used by other staging features.
