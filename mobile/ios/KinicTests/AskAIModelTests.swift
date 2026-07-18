// Where: mobile/ios/KinicTests/AskAIModelTests.swift
// What: End-to-end two-stage Ask AI state, call-order, fallback, and persistence tests.
// Why: Query generation is mandatory and no model text may be shown before final validation.

import Foundation
import Testing
@testable import Kinic

@MainActor
struct AskAIModelTests {
    @Test
    func successfulQuestionCallsChatExactlyTwiceAndPublishesValidatedAnswer() async throws {
        let source = contextSource()
        let knowledge = AskAIKnowledgeProviderStub(sources: [source])
        let client = AskAICompletionStub(responses: [
            .value("<answer>\nx402 paid api route\nx402 有料 api ルート\n</answer>"),
            .value("<sources>S1</sources><answer>Grounded answer.</answer>")
        ])
        let store = AskAIStoreStub()
        let model = AskAIModel(knowledgeProvider: knowledge, client: client, store: store)
        await model.load()

        model.draft = "x402の有料APIルートは？"
        model.send()
        try await waitUntilFinished(model)

        #expect(await client.callCount == 2)
        let messages = await client.messages
        #expect(messages[0].contains("SEARCH QUERY REWRITER"))
        #expect(messages[1].contains("DATABASE SOURCES"))
        #expect(knowledge.receivedDatabaseIds == ["db_test"])
        #expect(knowledge.receivedPlans.first?.queries.map(\.text) == [
            "x402 paid api route", "x402 有料 api ルート"
        ])
        #expect(model.messages.last?.state == .complete)
        #expect(model.messages.last?.text == "Grounded answer.")
        #expect(model.messages.last?.sources == [source.source])
        #expect(model.messages.last?.trace.first?.title == "Generated search queries")
        #expect(model.messages.last?.trace.first?.detail == "x402 paid api route\nx402 有料 api ルート")
        try await waitForSavedMessage(store, state: .complete)
    }

    @Test
    func zeroSearchResultsCallOnlyQueryPlannerAndBecomeInsufficient() async throws {
        let knowledge = AskAIKnowledgeProviderStub(sources: [])
        let client = AskAICompletionStub(responses: [.value("<answer>unknown topic</answer>")])
        let model = AskAIModel(knowledgeProvider: knowledge, client: client, store: AskAIStoreStub())
        await model.load()

        model.draft = "Unknown topic"
        model.send()
        try await waitUntilFinished(model)

        #expect(await client.callCount == 1)
        #expect(knowledge.retrievalCallCount == 1)
        #expect(model.messages.last?.state == .insufficient)
        #expect(model.messages.last?.trace.contains { $0.title == "Found 0 matching notes" } == true)
    }

    @Test
    func invalidQueryPlanFailsWithoutSearchOrAnswerFallback() async throws {
        let knowledge = AskAIKnowledgeProviderStub(sources: [contextSource()])
        let client = AskAICompletionStub(responses: [.value("Here is a query")])
        let model = AskAIModel(knowledgeProvider: knowledge, client: client, store: AskAIStoreStub())
        await model.load()

        model.draft = "Question"
        model.send()
        try await waitUntilFinished(model)

        #expect(await client.callCount == 1)
        #expect(knowledge.retrievalCallCount == 0)
        #expect(model.messages.last?.state == .failed)
        #expect(model.errorMessage == AskAIQueryPlanError.invalidFormat.localizedDescription)
    }

    @Test
    func unknownAnswerSourceFailsAfterTwoCallsWithoutShowingText() async throws {
        let knowledge = AskAIKnowledgeProviderStub(sources: [contextSource()])
        let client = AskAICompletionStub(responses: [
            .value("<answer>question</answer>"),
            .value("<sources>S9</sources><answer>Unsupported</answer>")
        ])
        let model = AskAIModel(knowledgeProvider: knowledge, client: client, store: AskAIStoreStub())
        await model.load()

        model.draft = "Question"
        model.send()
        try await waitUntilFinished(model)

        #expect(await client.callCount == 2)
        #expect(model.messages.last?.state == .failed)
        #expect(model.messages.last?.text != "Unsupported")
        #expect(model.errorMessage == AskAIResponseError.invalidSources.localizedDescription)
    }

    @Test
    func answerContentIsNotDisplayedWhileSecondCompletionIsPending() async throws {
        let client = AskAICompletionStub(responses: [
            .value("<answer>question</answer>"),
            .delayed("<sources>S1</sources><answer>Final only</answer>", .milliseconds(80))
        ])
        let model = AskAIModel(
            knowledgeProvider: AskAIKnowledgeProviderStub(sources: [contextSource()]),
            client: client,
            store: AskAIStoreStub()
        )
        await model.load()

        model.draft = "Question"
        model.send()
        for _ in 0..<200 {
            if await client.callCount == 2 { break }
            try await Task.sleep(for: .milliseconds(2))
        }
        #expect(model.messages.last?.state == .generating)
        #expect(model.messages.last?.text.isEmpty == true)
        #expect(model.messages.last?.sources.isEmpty == true)

        try await waitUntilFinished(model)
        #expect(model.messages.last?.text == "Final only")
    }

    @Test
    func databaseChangeDuringQueryGenerationStopsBeforeRetrieval() async throws {
        let knowledge = AskAIKnowledgeProviderStub(sources: [contextSource()])
        let client = AskAICompletionStub(responses: [
            .delayed("<answer>question</answer>", .milliseconds(80)),
            .value("<sources>S1</sources><answer>Wrong database answer.</answer>")
        ])
        let model = AskAIModel(knowledgeProvider: knowledge, client: client, store: AskAIStoreStub())
        await model.load()

        model.draft = "Question"
        model.send()
        try await waitForCallCount(client, count: 1)
        knowledge.selectedAskAIDatabaseId = "db_other"
        try await waitUntilFinished(model)

        #expect(await client.callCount == 1)
        #expect(knowledge.retrievalCallCount == 0)
        #expect(model.messages.last?.state == .failed)
        #expect(model.messages.last?.text == "Generation stopped.")
        #expect(model.messages.last?.sources.isEmpty == true)
    }

    @Test
    func databaseChangeDuringAnswerGenerationDiscardsCompletedResponse() async throws {
        let knowledge = AskAIKnowledgeProviderStub(sources: [contextSource()])
        let client = AskAICompletionStub(responses: [
            .value("<answer>question</answer>"),
            .delayed("<sources>S1</sources><answer>Wrong database answer.</answer>", .milliseconds(80))
        ])
        let model = AskAIModel(knowledgeProvider: knowledge, client: client, store: AskAIStoreStub())
        await model.load()

        model.draft = "Question"
        model.send()
        try await waitForCallCount(client, count: 2)
        knowledge.selectedAskAIDatabaseId = "db_other"
        try await waitUntilFinished(model)

        #expect(await client.callCount == 2)
        #expect(knowledge.receivedDatabaseIds == ["db_test"])
        #expect(model.messages.last?.state == .failed)
        #expect(model.messages.last?.text == "Generation stopped.")
        #expect(model.messages.last?.text != "Wrong database answer.")
        #expect(model.messages.last?.sources.isEmpty == true)
    }

    @Test
    func openingSourceUsesCurrentConversationDatabase() async {
        let knowledge = AskAIKnowledgeProviderStub(sources: [])
        let conversation = AskAIConversation(
            databaseId: "db_history",
            databaseTitle: "History DB"
        )
        let model = AskAIModel(
            knowledgeProvider: knowledge,
            client: AskAICompletionStub(responses: []),
            store: AskAIStoreStub(savedConversations: [conversation])
        )
        await model.load()
        model.selectConversation(conversation)
        knowledge.selectedAskAIDatabaseId = "db_other"
        let source = contextSource().source

        model.openSource(source)

        #expect(knowledge.openedDatabaseIds == ["db_history"])
        #expect(knowledge.openedPaths == [source.path])
    }

    @Test
    func recentHistoryIsSentToQueryPlannerForReferenceResolution() async throws {
        let prior = AskAIConversation(
            databaseId: "db_test",
            databaseTitle: "Test DB",
            messages: [
                AskAIMessage(role: .user, text: "Tell me about ic-hono"),
                AskAIMessage(role: .assistant, text: "Previous answer", state: .complete)
            ]
        )
        let store = AskAIStoreStub(savedConversations: [prior])
        let client = AskAICompletionStub(responses: [.value("<answer>ic-hono compatibility</answer>")])
        let model = AskAIModel(
            knowledgeProvider: AskAIKnowledgeProviderStub(sources: []),
            client: client,
            store: store
        )
        await model.load()

        model.draft = "それは互換ですか？"
        model.send()
        try await waitUntilFinished(model)

        let prompt = await client.messages.first
        #expect(prompt?.contains("USER: Tell me about ic-hono") == true)
        #expect(prompt?.contains("CURRENT QUESTION:\nそれは互換ですか？") == true)
    }

    @Test
    func overallTimeoutCancelsQueryGenerationAndPersistsFailure() async throws {
        let client = AskAICompletionStub(responses: [.delayed("<answer>late</answer>", .seconds(60))])
        let store = AskAIStoreStub()
        let model = AskAIModel(
            knowledgeProvider: AskAIKnowledgeProviderStub(sources: []),
            client: client,
            store: store,
            generationTimeout: .milliseconds(20)
        )
        await model.load()

        model.draft = "Question"
        model.send()
        try await waitUntilFinished(model)

        #expect(model.messages.last?.state == .failed)
        #expect(model.messages.last?.text == "The answer took too long. Try again.")
        #expect(await client.cancellationCount == 1)
        try await waitForSavedMessage(store, state: .failed)
    }

    @Test
    func loadRecoversInterruptedGenerationAndResavesIt() async throws {
        let interrupted = AskAIMessage(
            role: .assistant,
            text: "Partial answer",
            state: .generating,
            sources: [contextSource().source],
            trace: [AskAITraceEvent(stage: .generating, title: "Writing", isActive: true)]
        )
        let conversation = AskAIConversation(
            databaseId: "db_test",
            databaseTitle: "Test DB",
            messages: [AskAIMessage(role: .user, text: "Question"), interrupted]
        )
        let store = AskAIStoreStub(savedConversations: [conversation])
        let model = AskAIModel(
            knowledgeProvider: AskAIKnowledgeProviderStub(sources: []),
            client: AskAICompletionStub(responses: []),
            store: store
        )

        await model.load()
        try await waitForSavedMessage(store, state: .failed)

        #expect(model.messages.last?.state == .failed)
        #expect(model.messages.last?.text == "Generation was interrupted.")
        #expect(model.messages.last?.sources.isEmpty == true)
    }

    private func waitUntilFinished(_ model: AskAIModel) async throws {
        for _ in 0..<400 where model.isGenerating {
            try await Task.sleep(for: .milliseconds(5))
        }
        #expect(!model.isGenerating)
    }

    private func waitForCallCount(_ client: AskAICompletionStub, count: Int) async throws {
        for _ in 0..<200 {
            if await client.callCount == count { return }
            try await Task.sleep(for: .milliseconds(2))
        }
        Issue.record("Expected \(count) Ask AI calls")
    }

    private func waitForSavedMessage(_ store: AskAIStoreStub, state: AskAIMessageState) async throws {
        for _ in 0..<200 {
            if await store.savedConversations.first?.messages.last?.state == state { return }
            try await Task.sleep(for: .milliseconds(5))
        }
        Issue.record("Expected a saved \(state.rawValue) message")
    }

    private func contextSource() -> AskAIContextSource {
        AskAIContextSource(
            source: AskAISource(
                id: "S1",
                path: "/Knowledge/note.md",
                excerpt: "Grounded fact",
                score: -1,
                matchReasons: ["content_fts"]
            ),
            content: "Grounded fact from the database."
        )
    }
}

@MainActor
private final class AskAIKnowledgeProviderStub: AskAIKnowledgeProviding {
    var selectedAskAIDatabaseId = "db_test"
    var selectedAskAIDatabaseTitle = "Test DB"
    var canAskAI = true
    var askAIDatabaseCandidates: [DatabaseSummary] = []
    let sources: [AskAIContextSource]
    private(set) var retrievalCallCount = 0
    private(set) var receivedDatabaseIds: [String] = []
    private(set) var receivedPlans: [AskAIQueryPlan] = []
    private(set) var openedDatabaseIds: [String] = []
    private(set) var openedPaths: [String] = []

    init(sources: [AskAIContextSource]) {
        self.sources = sources
    }

    func selectAskAIDatabase(_ databaseId: String) {
        selectedAskAIDatabaseId = databaseId
    }

    func retrieveAskAISources(databaseId: String, queryPlan: AskAIQueryPlan) async throws -> AskAIRetrievalResult {
        retrievalCallCount += 1
        receivedDatabaseIds.append(databaseId)
        receivedPlans.append(queryPlan)
        return AskAIRetrievalResult(searchQueries: queryPlan.queries.map(\.text), sources: sources)
    }

    func openAskAISource(databaseId: String, path: String) {
        openedDatabaseIds.append(databaseId)
        openedPaths.append(path)
    }
}

private actor AskAICompletionStub: AskAICompleting {
    enum Response: Sendable {
        case value(String)
        case delayed(String, Duration)
    }

    let responses: [Response]
    private(set) var messages: [String] = []
    private(set) var cancellationCount = 0

    init(responses: [Response]) {
        self.responses = responses
    }

    var callCount: Int { messages.count }

    func completeContent(message: String, timeout: Duration) async throws -> String {
        let index = messages.count
        messages.append(message)
        guard responses.indices.contains(index) else {
            throw AskAIClientError.invalidResponse
        }
        do {
            switch responses[index] {
            case let .value(value):
                return value
            case let .delayed(value, delay):
                try await Task.sleep(for: delay)
                return value
            }
        } catch is CancellationError {
            cancellationCount += 1
            throw CancellationError()
        }
    }
}

private actor AskAIStoreStub: AskAIConversationPersisting {
    private(set) var savedConversations: [AskAIConversation]

    init(savedConversations: [AskAIConversation] = []) {
        self.savedConversations = savedConversations
    }

    func load() async throws -> [AskAIConversation] { savedConversations }
    func save(_ conversations: [AskAIConversation]) async throws { savedConversations = conversations }
}
