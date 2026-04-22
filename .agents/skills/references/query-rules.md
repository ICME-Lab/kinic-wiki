# Query Rules

## Goal

Keep query answers evidence-backed, minimal, and consistent.

## Rules

- Read at least one note that directly supports the final answer.
- Do not answer from `index.md`, a list result, or a search hit alone.
- Do not conclude absence until you have checked both `search-path-remote` and `search-remote` for the current scope.
- Preserve exact value formatting for dates, times, places, person names, identifiers, and other explicit attribute values.
- Do not paraphrase, normalize, or complete an exact value when the wiki already states it directly.
- If the question asks for a single turn, timestamp, or attribute value, prefer extraction over summarization.
- Return the smallest answer span that directly matches the evidence.
- Use normal synthesis only for open-ended, comparative, or multi-fact explanation questions.
- If the requested attribute or value is not directly supported by the notes you read, answer exactly `insufficient evidence`.
- For abstention questions, only an explicit statement in a note counts as evidence.
- For abstention questions, do not treat recap notes or cross-note synthesis as direct evidence for a missing relation or attribute.
- For abstention questions, if you only find adjacent context, implication, or summary-level overlap, answer exactly `insufficient evidence`.
- If the question is about order or time, do not answer from the index alone.
- Do not paraphrase quoted text or referenced turn content when the question asks for that exact item.

## Output

Prefer one of these outputs:

- a direct answer grounded in current wiki pages
- a comparison or synthesis summary
