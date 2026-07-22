// Where: mobile/ios/KinicApp/Services/AskAIRetrievalVerifier.swift
// What: Actor-isolated exact-match verification for retrieved Ask AI documents.
// Why: Full-document tokenization must not block the main actor that owns app state.

actor AskAIRetrievalVerifier {
    func hasRequiredExactMatches(
        queryPlan: AskAIQueryPlan,
        path: String,
        content: String
    ) -> Bool {
        AskAIRetrievalPlanner.hasRequiredExactMatches(
            queryPlan: queryPlan,
            path: path,
            content: content
        )
    }
}
