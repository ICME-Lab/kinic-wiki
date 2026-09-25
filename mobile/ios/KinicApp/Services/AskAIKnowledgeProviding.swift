// Where: mobile/ios/KinicApp/Services/AskAIKnowledgeProviding.swift
// What: Main-actor boundary between Ask AI and the authenticated VFS browser.
// Why: Conversation logic remains independently testable while AppModel retains session ownership.

import Foundation

@MainActor
protocol AskAIKnowledgeProviding: AnyObject {
    var selectedAskAIDatabaseId: String { get }
    var selectedAskAIDatabaseTitle: String { get }
    var askAIOutputLanguage: WikiOutputLanguage { get }
    var canAskAI: Bool { get }
    var askAIDatabaseCandidates: [DatabaseSummary] { get }
    var usesWorkerAskAI: Bool { get }
    var hasAskAIWorkerConsent: Bool { get }

    func selectAskAIDatabase(_ databaseId: String) -> BrowseDatabaseSelectionDisposition
    func retrieveAskAISources(databaseId: String, queryPlan: AskAIQueryPlan) async throws -> AskAIRetrievalResult
    func openAskAISource(databaseId: String, path: String)
    func answerAskAIWithWorker(
        conversationId: UUID,
        databaseId: String,
        databaseTitle: String,
        question: String,
        history: [AskAIMessage]
    ) async throws -> AskAIWorkerResult
    func cancelAskAIWorkerTurn() async throws
    func endAskAIWorkerConversation() async throws
    func grantAskAIWorkerConsent()
}

struct AskAIWorkerResult: Sendable {
    let kind: String
    let answer: String
    let sources: [AskAISource]
    let trace: AssistantRetrievalTrace?
    let insufficient: Bool
}

extension AskAIKnowledgeProviding {
    var usesWorkerAskAI: Bool { false }
    var hasAskAIWorkerConsent: Bool { true }
    func grantAskAIWorkerConsent() {}
    func cancelAskAIWorkerTurn() async throws {}
    func endAskAIWorkerConversation() async throws {}

    func answerAskAIWithWorker(
        conversationId: UUID,
        databaseId: String,
        databaseTitle: String,
        question: String,
        history: [AskAIMessage]
    ) async throws -> AskAIWorkerResult {
        throw AskAIKnowledgeError.workerUnavailable
    }
}
