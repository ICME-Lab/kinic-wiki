// Where: mobile/ios/KinicApp/Services/AskAIRetrievalVerifier.swift
// What: Actor-isolated exact-match verification for retrieved Ask AI documents.
// Why: Full-document tokenization must not block the main actor that owns app state.

actor AskAIRetrievalVerifier {
    func prepareVerifiedEvidence(
        queryPlan: AskAIQueryPlan,
        hit: SearchNodeHit,
        content: String
    ) -> AskAIRetrievalPlanner.PreparedEvidence? {
        let evidence = AskAIRetrievalPlanner.prepareEvidence(
            queryPlan: queryPlan,
            hit: hit,
            content: content
        )
        guard AskAIRetrievalPlanner.hasRequiredExactMatches(
            queryPlan: queryPlan,
            content: "\(evidence.excerpt)\n\(evidence.content)"
        ) else {
            return nil
        }
        return evidence
    }

    func hasRequiredExactMatches(
        queryPlan: AskAIQueryPlan,
        content: String
    ) -> Bool {
        AskAIRetrievalPlanner.hasRequiredExactMatches(
            queryPlan: queryPlan,
            content: content
        )
    }
}
