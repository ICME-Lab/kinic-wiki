// Where: mobile/ios/KinicApp/Models/AskAIQueryPlan.swift
// What: Validated AI-generated search queries for one Ask AI request.
// Why: Retrieval must consume only bounded, normalized query variants.

import Foundation

struct AskAIQueryPlan: Equatable, Sendable {
    struct Query: Equatable, Sendable {
        let text: String
        let terms: [String]
    }

    let queries: [Query]
}
