// Where: mobile/ios/KinicApp/Models/AskAIRetrievalResult.swift
// What: AI-generated search queries and verified wiki sources produced for one Ask AI question.
// Why: The conversation trace must explain the actual retrieval query without exposing unverified hits.

import Foundation

struct AskAIRetrievalResult: Equatable, Sendable {
    let searchQueries: [String]
    let candidateCount: Int
    let sources: [AskAIContextSource]
}
