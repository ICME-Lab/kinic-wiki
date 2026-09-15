# Privacy Policy

Last Updated: August 5, 2026
Effective Date: August 5, 2026

## 1. Who we are

Kinic ("Kinic," "we," "our," or "us") provides iOS and browser-based software, command-line tools, and canister-backed storage that let users create, manage, search, and use a personal knowledge base on the Internet Computer (the "Service").

This Privacy Policy explains the information the Service processes, where that information is stored, how it is protected, and the choices available to users.

## 2. Information we process

We do not require or collect an email address, real name, or Kinic username to use the Service. We do not use advertising analytics, advertising identifiers, or cross-service tracking.

The Service processes the following information when needed to provide features requested by the user:

### Authentication and access information

- An Internet Identity principal or another supported principal used to authenticate the user.
- Database membership, ownership, and role information needed to enforce access controls.
- Database and canister identifiers needed to locate the user's data.

### Content the user directs the Service to store

- URLs submitted for capture.
- Notes, wiki documents, source material, and other content the user writes, imports, or generates.
- Database names, descriptions, tags, access-control settings, and related metadata.

This content is stored in Internet Computer canister state. Except for the consented, bounded preview excerpts described below, Kinic does not create a separate centralized copy of the user's knowledge-base content and does not routinely inspect it.

### Cycles and transaction information

When a user funds a database or uses a paid database feature, the Service processes the relevant principal, operation identifier, token amount, ledger block reference, database identifier, status, and timestamp. Public-ledger transactions may also be visible on the applicable blockchain.

### Ask AI transient processing

When the user submits an Ask AI question, the iOS app sends the following information to Kinic's AI service:

- The current question.
- The selected database name.
- Up to six recent conversation messages, subject to a character limit.
- Relevant excerpts and bounded portions of notes selected from that database.

For the existing text Ask AI service, Kinic directly operates the AI service and does not forward this information to a third-party AI provider. The information is used only to generate search queries and the requested answer. Request bodies are not retained in logs, caches, databases, analytics systems, or training datasets. They are discarded after the request completes, fails, or is cancelled.

Ask AI conversation history is stored locally on the iOS device. It is not uploaded as server-side conversation history, although the bounded recent messages described above are transmitted transiently with a later question when needed to understand that question.

### Optional voice preview (disabled pending release acceptance)

The optional iOS Voice preview is separate from existing text Ask AI and its local history. When enabled for an invited user and permitted by the selected database owner, it asks for consent before sending questions, conversation context and necessary Wiki excerpts to OpenAI. Starting voice also sends microphone audio directly to OpenAI. Voice continues while the device is locked or another app is foreground until the user stops it, an interruption occurs, or a server limit ends it. Muting stops microphone audio from being sent without ending the connection.

OpenAI Agents sessions are stored in the United States and do not support Zero Data Retention. Kinic keeps encrypted bounded conversation content, tool results and short-lived authorization material in Cloudflare D1 to operate and recover the preview. Bearer tokens are stored as hashes. The iOS app may also keep a temporary preview cache in a device-protected area excluded from backups; it restores that cache only after checking authorization and server conversation state, and never automatically restarts recording. New preview conversations are not added to the existing local QA history. Kinic does not persist voice recordings.

Ending the conversation, signing out, changing database or account, or reaching the session deadline removes application conversation content and requests deletion of the OpenAI session. This does not promise immediate erasure of every provider record. Failed cleanup retains provider and reservation identifiers and retry metadata, without conversation content. Removing current D1 records does not immediately remove prior encrypted copies from Cloudflare backup history. D1 Time Travel retains recovery history according to the applicable service retention period; see [Cloudflare Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/). The temporary device cache is removed on conversation end, logout or database/account change. Content-free billing records retain database, authorized user, session identifier, rate version, confirmed duration and cycles amounts; access follows the database's billing-history permissions.

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
- **Ask AI request data:** Questions, recent-message context, and note excerpts exist only while the request is processed and are then discarded. They are not retained server-side.
- **iOS conversation history:** Ask AI conversations remain on the device until the user deletes them in the app or removes the app and its local data.

## 5. Sharing and disclosure

We do not sell personal information. We do not share information for advertising, profiling, or cross-service tracking. Existing text Ask AI data is not sent to a third-party AI provider. The optional voice preview described above uses OpenAI when enabled and explicitly selected.

Information may be processed or disclosed only to:

- Internet Computer node providers that operate the replicated network on which canister state is stored.
- Service providers that perform necessary infrastructure or support functions under appropriate confidentiality and data-protection obligations.
- Authorities or other parties when disclosure is required by law, necessary to protect users or the Service, or needed to establish or defend legal claims.
- Other users when the database owner deliberately makes a database public, grants access, or publishes content through a Service feature.

## 6. International transfers

Internet Computer nodes and necessary service infrastructure may operate in multiple countries. Information may therefore be processed outside the user's country. Where required, we rely on applicable transfer mechanisms and legal bases, including performance of the Service requested by the user and appropriate contractual or technical safeguards.

## 7. Your rights and choices

Depending on the user's location, the user may have rights to access, correct, export, delete, restrict, or object to processing of information associated with the user.

Users can manage or delete knowledge-base content and database access through available Service interfaces. Signed-in iOS users can delete their Kinic account data from Settings > Delete Account. After the server accepts the deletion, the app also deletes that principal's Ask AI history, capture history, queued URLs, database selection data, and authentication session from the device. Some transaction records, the initial-free-grant usage record, public-ledger records, and underlying replicated-state history cannot be altered or deleted by Kinic.

To ask a privacy question or exercise a right, contact us at [https://x.com/kinic_app](https://x.com/kinic_app). We may need information sufficient to verify the requester's authority over the relevant principal or database.

## 8. Cookies and similar technologies

The Kinic website uses only technologies necessary to operate the website and requested features. The native iOS app does not include advertising trackers or analytics SDKs and does not perform cross-app tracking. Browser-based Kinic software does not set third-party advertising cookies.

## 9. Children

The Service is not directed to children under 13, and we do not knowingly process personal information from children under 13. If we learn that such information has been provided, we will take reasonable steps to remove it where technically and legally possible.

## 10. Changes to this Policy

We will post changes to this Policy on the public Privacy Policy page and update the "Last Updated" date. Material changes posted after this Policy's Effective Date take effect 30 days after posting unless a longer period is required by law. We may provide additional notice where required.

## 11. Contact us

For questions or feedback about this Privacy Policy, contact us at [https://x.com/kinic_app](https://x.com/kinic_app).
