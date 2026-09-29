# Privacy Policy

Last Updated: September 29, 2026
Effective Date: September 29, 2026

## 1. Who we are

Kinic ("Kinic," "we," "our," or "us") provides iOS and browser-based software, command-line tools, the Kinic Wiki app for ChatGPT and other Model Context Protocol (MCP) clients, and canister-backed storage that let users create, manage, search, and use a personal knowledge base on the Internet Computer (the "Service").

This Privacy Policy explains the information the Service processes, where that information is stored, how it is protected, and the choices available to users.

## 2. Information we process

Ordinary users do not need to provide an email address, real name, or Kinic username to authenticate with Internet Identity. Content users choose to store or send through tools may itself contain personal information. We do not use advertising analytics, advertising identifiers, or cross-service tracking.

The Service processes the following information when needed to provide features requested by the user:

### Authentication and access information

- An Internet Identity principal or another supported principal used to authenticate the user.
- Database membership, ownership, and role information needed to enforce access controls.
- Database and canister identifiers needed to locate the user's data.

### Content the user directs the Service to store

- URLs submitted for capture.
- Notes, wiki documents, source material, and other content the user writes, imports, or generates.
- Database names, descriptions, tags, access-control settings, and related metadata.

This content is stored in Internet Computer canister state. The AI features described below may keep bounded active conversation copies, and the ChatGPT/MCP connection returns requested content to the connected client. Kinic does not routinely inspect knowledge-base content.

### Kinic Wiki for ChatGPT and other MCP clients

Connecting this app lets the client request Wiki operations within the connected user's database permissions. This connection is separate from iOS Ask AI and the Wiki Clipper's ChatGPT Recall feature. The MCP service receives the arguments the client sends for a tool call; it does not retrieve the user's full ChatGPT conversation history or unrelated chats.

The current tools process the following inputs and return the following information to the connected client, including OpenAI when used in ChatGPT:

| Tools and purpose | Inputs processed | Information returned |
| --- | --- | --- |
| `find_databases`: discover accessible databases | Optional search text and result limit | Database names, descriptions, tags, database identifiers, links, and relevance scores |
| `search`: find matching Wiki material | Database identifier, search text, path prefix, result limit, and preview preference | Matching titles, paths, identifiers, links, snippets or previews, node kinds, scores, and match reasons |
| `fetch_many`, `read_path`, `read_paths`: read selected material | Selected result identifiers or Wiki URLs, or a database identifier and paths | Requested text, titles, paths, links, node kinds, creation/modification dates, user-supplied metadata, content-version identifiers (etags), and truncation or item-error information |
| `list`, `memory_manifest`: inspect structure and supported operations | Database identifier and, for listing, a path prefix, recursion choice, and result limit | Paths, node kinds, modification dates, etags, child indicators, roots, role definitions, capabilities, write policy, and limits |
| `context`: obtain evidence for a task | Database identifier, task description, namespace, context budget, depth, and evidence preference | Task description, selected Wiki text and metadata, links between notes, source references, search excerpts, and content-version information |
| `write_nodes`, `mutate_nodes_batch`: create, replace, append, edit, move, or delete material | Database identifier, paths, content, metadata, edit text, move destinations, deletion options, and any conflict-check etags | Operation results and affected paths/version information; failures may include the conflicting path, current etag, and bounded current content to help resolve a conflict |

These fields locate the requested database and content, supply evidence and citations, carry out requested edits, enforce permissions, and detect conflicting changes. Notes, source material, titles, paths, URLs, and metadata may contain personal information about the user or other people. That information is included when it is part of the requested tool input or returned material.

The request passes through Kinic's Cloudflare Worker to the Internet Computer canister; the result returns through the Worker to the client. Read tools can return private content accessible to the connected user. Write tools persist changes in the selected Wiki database. Changes are visible to other authorized users and may be public where the database or affected content is already public. The MCP tools do not invoke the TypeSafe or DeepSeek processing described for other features below.

To authenticate the connection and enforce its permissions, Kinic processes client identifiers, redirect addresses, permission and connection records, principal/delegation information, and authentication credentials. Connection records are stored in Cloudflare Durable Objects; keys and delegation material are encrypted, and tokens are stored as verification hashes. Authentication credentials are not included in tool results.

Kinic uses the connecting IP address to rate-limit client registration and sign-in attempts. For security and reliability, Cloudflare processes request URLs, timestamps, status codes, and execution identifiers, and Kinic logs connection outcomes and errors. Kinic's application log messages do not include Wiki text, tool arguments, raw principals, tokens, or keys. These records are not used for advertising or behavioral profiling.

### Cycles and transaction information

When a user funds a database or uses a paid database feature, the Service processes the relevant principal, operation identifier, token amount, ledger block reference, database identifier, status, and timestamp. Public-ledger transactions may also be visible on the applicable blockchain.

### Ask AI processing

When the user starts the consented Ask AI Agent feature and submits a question, Kinic processes:

- The current question.
- The selected database and search scope.
- Up to 20 candidate Wiki paths and short search previews.
- Relevant excerpts and bounded portions of notes and source material selected from that database.
- Bounded recent conversation context when needed to answer the question.

Kinic sends every submitted question, the selected target type or path, and up to six recent conversation messages totaling up to 4,000 characters to TypeSafe's United States service to classify whether the request is a database overview, a selected-page summary, a focused search, or ordinary conversation. For focused searches, Kinic additionally sends candidate paths and previews to TypeSafe for ranking. Paths and previews returned to the answering agent are routing data and are not treated as citation evidence. For iOS typed Ask AI requests, Kinic sends the question, bounded conversation context, and necessary Wiki excerpts to DeepSeek to generate the answer. DeepSeek is based in China; its [published privacy policy](https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html) describes processing and storage in China. Processing of API data is subject to the applicable provider terms; Kinic does not promise Zero Data Retention or immediate provider erasure. Voice-delegated questions and the browser Agent continue to use OpenAI's United States service. [TypeSafe's Privacy Policy](https://typesafe.ai/privacy) states that it does not train or fine-tune artificial-intelligence or machine-learning models on customer Input. TypeSafe does not offer Zero Data Retention under that public policy: it retains personal data for as long as reasonably necessary to provide its services or support its business or commercial purposes, subject to deletion requests and legal obligations.

Kinic logs only bounded operational measurements for routing and reranking, such as workflow, candidate and selected counts, selected route, elapsed time, input character count, and HTTP status. Questions, Wiki text, paths, previews, probabilities, and API keys are not included in those logs.

Ask AI conversation history is stored locally on the iOS device. The Agent feature also keeps encrypted bounded active conversation state in Cloudflare D1 so it can operate and recover an active conversation. Ending the conversation removes active Kinic conversation content and requests deletion of any OpenAI session used, subject to the provider and backup limitations below. iOS text answers use DeepSeek Chat Completions without creating a persistent provider session; ending the Kinic conversation does not delete any records retained by DeepSeek.

### Source Capture generation

When Source Capture generates a Wiki page, Kinic sends the beginning of the captured source material (up to 4,000 characters as part of the search intent) and up to 20 candidate Wiki paths and short previews to TypeSafe's United States service. TypeSafe returns relevance probabilities used to select up to five candidates. The source material and selected context are then sent to the configured generation provider, currently DeepSeek, to create the requested page. The TypeSafe training and retention terms described above also apply to Source Capture reranking.

### Wiki Clipper capture and conversation export

When the user starts an active-tab capture, the Wiki Clipper reads that page's URL, title, and extracted page text and sends the source to the selected Kinic Wiki database for capture and generation. When the user starts a ChatGPT, Claude, or Gemini export, the extension reads the selected conversation's title, URL, message roles, and message content and saves them as evidence source files in that database. These captures and exports require Internet Identity authentication and a writable database selected in the extension. The extension does not export conversations automatically. The Source Capture generation processing described above applies when a captured source is used to generate a Wiki page.

### ChatGPT Recall

After the user selects a Wiki database in the Wiki Clipper, Kinic searches it for the current ChatGPT question. There is no separate Recall switch; signing out clears the database selection and stops Recall searches. When Jev relevance ranking is available, the question and up to 20 candidate Wiki paths and short previews are sent through Kinic Wiki to TypeSafe's United States service. Jev may select up to three cards or none. If ranking is unavailable, Recall shows the existing search results. Recall does not save the question or preview text in Kinic operational logs, and it does not automatically send a selected Wiki excerpt to ChatGPT. The user chooses whether to insert context. The TypeSafe training and retention terms above apply.

### Optional voice preview (disabled pending release acceptance)

The optional iOS voice conversation uses the same on-device conversation history as Ask AI. When permitted by the selected database owner, it asks for consent before sending questions, conversation context and necessary Wiki excerpts to OpenAI. Starting voice also sends microphone audio directly to OpenAI. Voice continues while the device is locked or another app is foreground until the user stops it, an interruption occurs, or a server limit ends it. Muting stops microphone audio from being sent without ending the connection.

OpenAI Agents sessions are stored in the United States and do not support Zero Data Retention. Kinic keeps encrypted bounded conversation content, tool results and short-lived authorization material in Cloudflare D1 to operate and recover the preview. Bearer tokens are stored as hashes. The iOS app may also keep a temporary preview cache in a device-protected area excluded from backups; the cache is separated by signed-in account. Text transcripts and cited answers are saved to the existing on-device Ask AI history, including when recovering a previously interrupted conversation. A new microphone connection requires opening voice; restoring history alone never starts recording. Ending voice stops the connection without deleting on-device history; users delete that history separately. Kinic does not persist voice recordings.

Ending the conversation, signing out, changing database or account, or reaching the session deadline removes active server conversation content and requests deletion of the OpenAI session. This does not promise immediate erasure of every provider record. Failed cleanup retains provider and reservation identifiers and retry metadata, without conversation content. Removing current D1 records does not immediately remove prior encrypted copies from Cloudflare backup history. D1 Time Travel retains recovery history according to the applicable service retention period; see [Cloudflare Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/). The temporary device cache is removed after confirmed history persistence and successful conversation end. If saving or cleanup fails, an account-scoped recovery copy remains until retry succeeds. Saved Ask AI history is deleted separately by the user. Content-free billing records retain database, authorized user, session identifier, rate version, confirmed duration and cycles amounts; access follows the database's billing-history permissions.

The preview charges the selected database's service credits, denominated in cycles, at the displayed connection-time rate. Silence, microphone mute and device-lock time are included. Reservations protect the agreed budget; unused reservations are released. Existing StoreKit purchase verification remains unchanged. The operator pays infrastructure and AI providers separately.

The preview remains disabled until staging, device, pricing and privacy-disclosure acceptance are complete. Publication dates and App Store disclosures must be updated before activation.

## 3. How we store and secure information

Traffic between supported clients and Kinic services is protected in transit using TLS or the Internet Computer's authenticated protocol as applicable.

Knowledge-base content is stored in Internet Computer canister state and is protected by role-based access controls implemented by the Service. Only principals with the required database role, public access where the owner has enabled it, or an authorized automated service acting for a requested feature can access the applicable data through the Service's interfaces.

The production canister is hosted on an Internet Computer confidential subnet that uses AMD Secure Encrypted Virtualization Secure Nested Paging (SEV-SNP). This infrastructure encrypts virtual-machine memory and uses hardware-derived sealing keys to protect persistent node storage. These infrastructure protections reduce access by host and node operators; they are separate from the Service's application-level role-based access controls.

Kinic personnel do not routinely access user content. Access may occur only when necessary to perform a user-requested operation, investigate a security or reliability incident, comply with law, or when the user has authorized access. Canister controllers retain the technical ability to maintain and upgrade the Service.

No system can be guaranteed completely secure. Users should not store secrets such as private keys, seed phrases, passwords, or unencrypted authentication tokens in the Service.

## 4. How long we keep information

- **Canister content:** Content remains in canister state until the user deletes the item or database through an available Service interface. Deletion removes the content from accessible application state. Because the Internet Computer uses replicated state and blockchain-based infrastructure, deletion may not immediately erase every underlying historical or physical copy.
- **Authentication and access information:** Membership and role records remain while needed to provide database access and are removed when the applicable access or database is deleted, subject to replicated-state limitations.
- **Account deletion:** A signed-in user can initiate account deletion from Settings in the iOS app. Databases for which the user is the only owner are deleted. If another owner remains, the database remains and the deleting user's membership is removed. The user's other database memberships, purchased-database access, active marketplace listings, and temporary service sessions are also removed. Internet Identity is a separate service and is not deleted by this action.
- **Cycles and transactions:** Service-side operational records are retained as needed to maintain balances, prevent duplicate settlement, resolve transactions, and satisfy legal obligations. This includes the record that an initial free database grant was used, so deleting and recreating Kinic access does not issue another grant. Records written to a public ledger cannot be deleted by Kinic.
- **MCP tool content:** The MCP Worker processes tool arguments and results for the request without maintaining a separate durable Wiki-content or chat-history store. Requested writes remain in the Wiki under the canister-content rule above. Results delivered to ChatGPT or another client are subject to that client's retention and deletion controls; deleting the Wiki original does not delete those copies.
- **MCP authentication:** Pending connections and authorization codes expire after at most 10 minutes. Access tokens are valid for at most one hour; rotating refresh tokens cannot extend the connection beyond its eight-hour session cap or an earlier Internet Identity grant expiry. Session records, including token hashes and encrypted keys, are scheduled for deletion at the applicable session deadline or removed when the service invalidates the session. OAuth client registration records expire and are scheduled for deletion after 180 days without use; use renews that deadline.
- **MCP operational records and recovery copies:** Cloudflare Workers Logs retains logs for up to seven days under its [published retention limits](https://developers.cloudflare.com/workers/observability/logs/workers-logs/). Deleted SQLite-backed Durable Object authentication records may remain recoverable for up to 30 days through [Cloudflare's point-in-time recovery](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/). These recovery copies are separate from active authorization and do not extend credential validity.
- **Ask AI active data:** Kinic removes active encrypted conversation content when the conversation ends or another documented end condition occurs and requests deletion of any OpenAI session used. DeepSeek text requests do not create a persistent provider session. Provider records and Cloudflare backup history may remain for their applicable retention periods.
- **TypeSafe processing:** TypeSafe states that it retains personal data only as long as reasonably necessary for its services or business purposes, unless law requires longer retention, and accepts deletion requests as described in its policy. This is not Zero Data Retention.
- **Source Capture provider data:** Source excerpts, candidate paths and previews, and selected generation context are subject to the applicable TypeSafe and generation-provider retention terms.
- **iOS conversation history:** Ask AI conversations remain on the device until the user deletes them in the app or removes the app and its local data.

## 5. Sharing and disclosure

We do not sell personal information. We do not share information for advertising, profiling, or cross-service tracking. The consented Ask AI feature uses TypeSafe for intent classification and semantic reranking, DeepSeek for iOS text answers, and OpenAI for voice and browser Agent operation. Source Capture uses TypeSafe for semantic reranking and the configured generation provider, currently DeepSeek, for page generation.

Information may be processed or disclosed only to:

- OpenAI when the user connects Kinic Wiki to ChatGPT, or the provider of another MCP client the user chooses: receives tool results, including requested private Wiki content and metadata, to fulfill the user's request. Its own privacy policy, account settings, and applicable terms govern its processing of those copies. Kinic cannot delete copies held in a client's conversation history.
- Cloudflare: processes MCP requests and responses, stores authentication records in Durable Objects, and provides rate limiting and operational logging. This is separate from the D1 conversation storage used by the AI previews.
- Internet Identity: processes authentication and delegation requests to establish and manage the user's authorized connection.
- Internet Computer node providers that operate the replicated network on which canister state is stored.
- Service providers that perform necessary infrastructure or support functions under appropriate confidentiality and data-protection obligations.
- Authorities or other parties when disclosure is required by law, necessary to protect users or the Service, or needed to establish or defend legal claims.
- Other users when the database owner deliberately makes a database public, grants access, or publishes content through a Service feature.

## 6. International transfers

Internet Computer nodes and necessary service infrastructure may operate in multiple countries. Information may therefore be processed outside the user's country. Where required, we rely on applicable transfer mechanisms and legal bases, including performance of the Service requested by the user and appropriate contractual or technical safeguards.

## 7. Your rights and choices

Depending on the user's location, the user may have rights to access, correct, export, delete, restrict, or object to processing of information associated with the user.

Users can manage or delete knowledge-base content and database access through available Service interfaces. Signed-in iOS users can delete their Kinic account data from Settings > Delete Account. After the server accepts the deletion, the app also deletes that principal's Ask AI history, capture history, queued URLs, database selection data, and authentication session from the device. Some transaction records, the initial-free-grant usage record, public-ledger records, and underlying replicated-state history cannot be altered or deleted by Kinic.

For the ChatGPT/MCP connection, users can:

- Choose **Questions only** in Internet Identity for read access, or **Actions & questions** when authorizing edits. Writing also requires the client's write authorization and the appropriate database permissions. Read permission can expose accessible private Wiki content to the connected client.
- Disconnect Kinic Wiki in the client's app/connection settings to stop that client from making further requests, and disable or remove the connector in Internet Identity Settings to withdraw its grant. Already-issued short-lived delegated credentials may remain usable until they expire; disconnection is not deletion of stored Wiki content or previously returned results.
- Use available Wiki interfaces or authorized mutation tools to correct or delete content, and manage database membership and public visibility through the Wiki's access controls.
- Manage or delete conversations and adjust data controls separately in ChatGPT or the other connected client. Removing a connection or deleting a Wiki item does not erase content already delivered to that client or copied by other authorized users.

To ask a privacy question or exercise a right, contact us at [https://x.com/kinic_app](https://x.com/kinic_app). We may need information sufficient to verify the requester's authority over the relevant principal or database.

## 8. Cookies and similar technologies

The MCP authorization flow uses a secure, HTTP-only connection cookie with a maximum age of 10 minutes to bind the browser to the connection attempt; successful authorization clears it. It is not an advertising cookie.

The Kinic website uses only technologies necessary to operate the website and requested features. The native iOS app does not include advertising trackers or analytics SDKs and does not perform cross-app tracking. Browser-based Kinic software does not set third-party advertising cookies.

## 9. Children

The Service is not directed to children under 13, and we do not knowingly process personal information from children under 13. If we learn that such information has been provided, we will take reasonable steps to remove it where technically and legally possible.

## 10. Changes to this Policy

We will post changes to this Policy on the public Privacy Policy page and update the "Last Updated" date. The iOS typed Ask AI processing described in this September 29, 2026 update takes effect when this update is posted, but only for users who accept the updated Ask AI consent before submitting a new question. Posting this update alone does not send existing conversations or Wiki content to DeepSeek. Other material changes to existing processing take effect 30 days after posting unless a longer period is required by law. We may provide additional notice where required.

## 11. Contact us

For questions or feedback about this Privacy Policy, contact us at [https://x.com/kinic_app](https://x.com/kinic_app).
