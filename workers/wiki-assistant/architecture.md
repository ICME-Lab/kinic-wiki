# Assistant architecture

The browser Worker forwards only `/api/assistant/native/*` to the Assistant Worker. Its public Web panel and browser Agent API have been retired. Other `/api/assistant/*` requests return 404.

The iOS app authenticates with Internet Identity and sends typed questions to the Assistant Worker. The Worker verifies the delegation and Wiki read permission, uses TypeSafe Jev to classify the question and rerank bounded search previews, reads authorized canister content, then sends selected context to DeepSeek for an answer. Citation validation compares each cited excerpt with current-turn reads.

D1 stores encrypted conversation state and recovery checkpoints. A scheduled Worker resumes interrupted native work and enforces expiry. Cancellation aborts an active DeepSeek request and rejects late answers. DeepSeek has no server-side conversation session managed by Kinic Wiki.

The old OpenAI Agent adapter, dependency, Web panel, and API key binding have been removed. Historical Agent cleanup rows and jobs are retained in D1 for audit but are not processed by the current Worker. They contain identifiers and status, not Wiki answer content. The OpenAI Platform key itself must be revoked separately in the Platform account if it was dedicated to this service.

Voice routes return 404. Historical voice billing and migration data remain for compatibility; no provider call or charge is created from them.
