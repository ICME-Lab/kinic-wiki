// Where: mobile/ios/KinicApp/Services/AskAIKnowledgeProviding.swift
// What: Main-actor boundary between Ask AI and the authenticated VFS browser.
// Why: Conversation logic remains independently testable while AppModel retains session ownership.

import Foundation

@MainActor
protocol AskAIKnowledgeProviding: AnyObject {
    var selectedAskAIDatabaseId: String { get }
    var selectedAskAIDatabaseTitle: String { get }
    var canAskAI: Bool { get }
    var askAIDatabaseCandidates: [DatabaseSummary] { get }

    func selectAskAIDatabase(_ databaseId: String)
    func retrieveAskAISources(databaseId: String, queryPlan: AskAIQueryPlan) async throws -> AskAIRetrievalResult
    func openAskAISource(databaseId: String, path: String)
}
