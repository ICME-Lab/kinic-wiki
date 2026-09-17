# Web Ask AI preview — draft privacy amendment

Draft for review before enabling invitations. This file does not amend the published policy or set a posting/effective date. The existing policy's material-change notice period must be handled when publishing an approved amendment.

The existing statements about directly operated AI and transient-only processing describe **iOS Ask AI**. Retain those statements for that feature and qualify the general statements in sections 2, 4 and 5 accordingly. Add the following disclosure for the new, optional Web feature:

## Optional Web Ask AI preview

When you explicitly consent and start a Web Ask AI conversation, Kinic sends your questions, necessary excerpts from the selected Wiki database, and conversation context to OpenAI to generate answers. Starting voice additionally sends microphone audio to OpenAI's GPT-Live service. Kinic's application does not retain audio recordings, and Live session recording is disabled.

OpenAI's Agents API retains session state in the United States and does not support Zero Data Retention. Kinic also retains active conversation state, bounded source excerpts and short-lived authentication material in Cloudflare infrastructure to operate the conversation, verify citations and recover from brief connection failures. API keys are kept on the server; II credentials are encrypted at rest.

Ending the conversation, signing out, changing database/account or reaching the inactivity/disconnection limit removes conversation content from Kinic's active application storage and requests deletion of the OpenAI agent session. Failed deletions retain only the identifiers needed to reconcile and retry cleanup. A deletion request does not promise immediate erasure of every record held by infrastructure or AI providers under their applicable retention policies.

The preview has no server-side conversation-history list and does not save conversations to your Wiki. Usage counters and operational logs contain limited authentication/operation identifiers, timestamps, durations and usage totals, not message bodies or source excerpts. Kinic uses them to enforce invitation and usage limits and resolve failures. You can decline this feature and continue using Wiki browsing and editing.

The general statement “Ask AI data is not sent to a third-party AI provider” must be qualified to iOS Ask AI before this Web preview is enabled. Likewise, the general statement that Kinic creates no centralized copy of knowledge-base content must describe this optional, bounded processing exception. Final infrastructure log-retention settings and the applicable notice/posting dates must be recorded at publication.
