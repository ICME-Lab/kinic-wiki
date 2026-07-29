# KinicWiki App Store Metadata

## App

- Name: KinicWiki: AI Memory
- Subtitle: Save and browse your AI memory
- Bundle ID: xyz.kinic.ios.KinicWiki
- Share Extension Bundle ID: xyz.kinic.ios.KinicWiki.ShareExtension
- Team ID: AKN976G7AK
- App Group: group.xyz.kinic.ios.KinicWiki
- Primary category: Productivity
- Privacy Policy URL: https://wiki.kinic.xyz/privacy-policy

## Promotional Text

Capture links from Safari, organize them alongside knowledge, memory, sessions, and skills, and find them again when you or your AI needs them.

## Description

KinicWiki is a personal knowledge base for you and your AI.

Save web pages from Safari, organize knowledge into clear folders, and search everything from your iPhone or iPad. Keep sources, memory, sessions, and reusable skills together in one place.

With KinicWiki, you can:

- Capture links from the iOS share sheet
- Browse Knowledge, Memory, Sessions, Skills, and Sources
- Search across your wiki
- Ask questions using evidence from one selected database
- See which documents were searched and used for an answer
- Read Markdown documents
- Choose and manage multiple databases
- Control who can read or write each database

Sign in with Internet Identity and keep your wiki on the Internet Computer.

Create your first database at no cost. An initial usage grant is included so you can start building your AI memory right away. Additional databases or usage may require payment.

## Keywords

wiki, knowledge, capture, links, notes, Internet Computer

## What's New in 1.0.2

- Ask questions using evidence from one selected database.
- Review the notes searched and cited for each supported answer.
- Improved response completion handling for Kinic AI.
- Added clearer privacy information for transient Ask AI processing and on-device history.

## Screenshot Story

1. Your AI memory, organized
2. Save any web page from Safari
3. Turn links into lasting knowledge
4. Ask your memory, with sources
5. Keep your memory under your control

## Privacy Notes

- Uses Internet Identity for sign-in.
- Stores pending shared URLs and selected database ID in the app group container.
- Stores Ask AI conversation history on the device.
- Sends Ask AI questions, the selected database name, up to six recent conversation messages, and relevant document excerpts to Kinic's AI service to generate answers.
- Discards Ask AI request bodies after processing and does not retain them in logs, caches, databases, analytics, or training datasets.
- Does not send Ask AI data to a third-party AI provider.
- Ask AI does not answer when the selected database has no supporting document.
- Does not declare tracking.
- Does not collect analytics in the native app.

## App Privacy Review

- User ID: Internet Identity principal used for authentication and database access.
- Other User Content: URLs, notes, wiki documents, sources, and database metadata stored in canister state.
- Purchase History: Database funding and purchase records when those features are used.
- Purpose: App Functionality.
- Tracking: No.
- Ask AI request data is transient and is not retained after real-time processing.

## Review Notes

On the KinicWiki sign-in sheet, choose "Continue with Internet Identity", "Continue with Apple", or "Continue with Google". Internet Identity appears first and supports passkey-based access.

After signing in, select a readable database in Ask AI. Submit a question to see the notes searched and the sources cited for a supported answer. Ask AI sends the current question, selected database name, up to six recent messages, and relevant note excerpts to Kinic's directly operated AI service. Request bodies are discarded after processing, and completed conversation history is stored only on the device.

To test capture, select a writable database, then share an HTTP or HTTPS URL into "Save to KinicWiki".
