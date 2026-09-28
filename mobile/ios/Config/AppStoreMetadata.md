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
- Read Markdown documents, and edit existing notes outside Sources when you are an Owner or Writer
- Choose and manage multiple databases
- Control who can read or write each database

Sign in with Internet Identity and keep your wiki on the Internet Computer.

Create your first database at no cost. An initial usage grant is included so you can start building your AI memory right away. Additional databases or usage may require payment.

## Keywords

wiki, knowledge, capture, links, notes, Internet Computer

## What's New in 1.0.4

- Purchase database credits securely through the App Store.
- Improved Internet Identity sign-in and saved-session reliability.
- Improved database browsing and capture reliability.

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
- With explicit versioned consent, sends Ask AI questions, the selected target, and up to six recent conversation messages totaling up to 4,000 characters to TypeSafe in the United States for intent classification, and sends candidate paths and previews for focused search ranking.
- Sends questions, bounded conversation context, and relevant Wiki excerpts to OpenAI in the United States to operate the answering Agent. Active encrypted Worker state is retained only for bounded recovery; completed history remains on the device.
- Does not include questions, Wiki text, paths, previews, routing probabilities, or API keys in operational logs.
- Ask AI does not answer when the selected database has no supporting document.
- Does not declare tracking.
- Does not collect analytics in the native app.

## App Privacy Review

- User ID: Internet Identity principal used for authentication and database access.
- Other User Content: URLs, notes, wiki documents, sources, and database metadata stored in canister state.
- Purchase History: Database funding and purchase records when those features are used.
- Purpose: App Functionality.
- Tracking: No.
- Ask AI uses third-party processing and bounded encrypted recovery state as disclosed in the in-app consent and privacy policy.

## Review Notes

On the KinicWiki sign-in sheet, choose "Continue with Internet Identity", "Continue with Apple", or "Continue with Google". Internet Identity appears first and supports passkey-based access. KinicWiki does not use a separate username/password account; reviewers can create or access an account with the Apple Account already configured on the review device.

After signing in, open Browse and select the pre-populated database "Dom's Brain" to inspect its folders and documents. In Ask AI, select "Dom's Brain", review the TypeSafe/OpenAI consent, and submit a question to see the retrieval route and cited sources. Questions, the selected target, and bounded recent conversation context are sent to TypeSafe for intent classification; focused-search candidates are reranked there. Questions, bounded recent context, and relevant excerpts are sent to OpenAI. Active recovery state is encrypted and bounded, and completed conversation history is stored on the device.

To test writable features, create a database using the initial free database grant. Select that database, then share an HTTP or HTTPS URL into "Save to KinicWiki" to test capture.

To test account deletion, sign in, open Settings, and choose "Delete Account" under Account Deletion. The confirmation explains that sole-owned databases are permanently deleted, shared databases remain while the current user's access is removed, purchased access is revoked, and local account history is erased. Internet Identity itself and transaction records required for settlement and duplicate-grant prevention are not deleted. After successful deletion, the app signs out automatically.
