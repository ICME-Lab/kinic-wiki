// Where: mobile/ios/KinicTests/AskAIModelTests.swift
// What: End-to-end Ask AI state tests with in-memory knowledge, stream, and history boundaries.
// Why: Zero-result gating and response validation are the feature's primary safety contract.

import Foundation
import Testing
@testable import Kinic

@MainActor
struct AskAIModelTests {
    @Test
    func zeroSearchResultsDoNotCallAI() async throws {
        let knowledge = AskAIKnowledgeProviderStub(sources: [])
        let stream = AskAIStreamStub(chunks: ["GROUNDING: supported\nSOURCES: S1\n\nShould not appear"])
        let store = AskAIStoreStub()
        let model = AskAIModel(knowledgeProvider: knowledge, client: stream, store: store)
        await model.load()

        model.draft = "Unknown topic"
        model.send()
        try await waitUntilFinished(model)

        #expect(await stream.callCount == 0)
        #expect(model.messages.last?.state == .insufficient)
        #expect(model.messages.last?.sources.isEmpty == true)
    }

    @Test
    func validGroundedResponseStreamsAndPersists() async throws {
        let source = AskAIContextSource(
            source: AskAISource(
                id: "S1",
                path: "/Knowledge/note.md",
                excerpt: "Grounded fact",
                score: -1,
                matchReasons: ["content_fts"]
            ),
            content: "Grounded fact from the database."
        )
        let knowledge = AskAIKnowledgeProviderStub(sources: [source])
        let stream = AskAIStreamStub(chunks: [
            "GROUNDING: supported\nSOURCES: S1\n\nGrounded ",
            "answer."
        ])
        let store = AskAIStoreStub()
        let model = AskAIModel(knowledgeProvider: knowledge, client: stream, store: store)
        await model.load()

        model.draft = "What is recorded?"
        model.send()
        try await waitUntilFinished(model)

        #expect(model.messages.last?.state == .complete)
        #expect(model.messages.last?.text == "Grounded answer.")
        #expect(model.messages.last?.sources == [source.source])
        #expect(await stream.callCount == 1)
        try await Task.sleep(for: .milliseconds(20))
        #expect(await store.savedConversations.first?.messages.last?.text == "Grounded answer.")
    }

    @Test
    func unknownSourceReferenceBecomesFailure() async throws {
        let source = AskAIContextSource(
            source: AskAISource(id: "S1", path: "/note.md", excerpt: "Fact", score: 0, matchReasons: []),
            content: "Fact"
        )
        let knowledge = AskAIKnowledgeProviderStub(sources: [source])
        let stream = AskAIStreamStub(chunks: ["GROUNDING: supported\nSOURCES: S9\n\nUnsupported"])
        let model = AskAIModel(
            knowledgeProvider: knowledge,
            client: stream,
            store: AskAIStoreStub()
        )
        await model.load()

        model.draft = "Question"
        model.send()
        try await waitUntilFinished(model)

        #expect(model.messages.last?.state == .failed)
        #expect(model.errorMessage == AskAIResponseError.invalidSources.localizedDescription)
        #expect(!model.messages.contains(where: { $0.text == "Unsupported" }))
    }

    @Test
    func changingDatabaseCancelsActiveStreamAndPersistsStoppedConversation() async throws {
        let source = AskAIContextSource(
            source: AskAISource(id: "S1", path: "/note.md", excerpt: "Fact", score: 0, matchReasons: []),
            content: "Fact"
        )
        let knowledge = AskAIKnowledgeProviderStub(sources: [source])
        let stream = AskAIControlledStreamStub()
        let store = AskAIStoreStub()
        let model = AskAIModel(knowledgeProvider: knowledge, client: stream, store: store)
        await model.load()

        model.draft = "Question"
        model.send()
        for _ in 0..<200 {
            if await stream.callCount == 1 { break }
            try await Task.sleep(for: .milliseconds(5))
        }
        #expect(await stream.callCount == 1)

        knowledge.selectedAskAIDatabaseId = "db_other"
        knowledge.selectedAskAIDatabaseTitle = "Other DB"
        model.syncSelectedDatabase()

        #expect(!model.isGenerating)
        #expect(model.currentConversation?.databaseId == "db_other")
        #expect(model.messages.isEmpty)
        for _ in 0..<200 {
            if await stream.cancellationCount == 1,
               await store.savedConversations.first?.databaseId == "db_test" {
                break
            }
            try await Task.sleep(for: .milliseconds(5))
        }
        #expect(await stream.cancellationCount == 1)
        let stoppedConversation = await store.savedConversations.first { $0.databaseId == "db_test" }
        #expect(stoppedConversation?.messages.last?.state == .failed)
        #expect(stoppedConversation?.messages.last?.text == "Generation stopped.")
    }

    @Test
    func clearingDatabaseCancelsRetrievalBeforeAICall() async throws {
        let source = AskAIContextSource(
            source: AskAISource(id: "S1", path: "/note.md", excerpt: "Fact", score: 0, matchReasons: []),
            content: "Fact"
        )
        let knowledge = AskAIKnowledgeProviderStub(sources: [source], retrievalDelay: .seconds(60))
        let stream = AskAIStreamStub(chunks: ["GROUNDING: supported\nSOURCES: S1\n\nAnswer"])
        let store = AskAIStoreStub()
        let model = AskAIModel(knowledgeProvider: knowledge, client: stream, store: store)
        await model.load()

        model.draft = "Question"
        model.send()
        for _ in 0..<200 {
            if knowledge.retrievalCallCount == 1 { break }
            try await Task.sleep(for: .milliseconds(5))
        }
        #expect(knowledge.retrievalCallCount == 1)

        knowledge.selectedAskAIDatabaseId = ""
        knowledge.selectedAskAIDatabaseTitle = ""
        knowledge.canAskAI = false
        model.syncSelectedDatabase()
        try await Task.sleep(for: .milliseconds(20))

        #expect(!model.isGenerating)
        #expect(model.currentConversation == nil)
        #expect(await stream.callCount == 0)
        let stoppedConversation = await store.savedConversations.first { $0.databaseId == "db_test" }
        #expect(stoppedConversation?.messages.last?.state == .failed)
        #expect(stoppedConversation?.messages.last?.text == "Generation stopped.")
    }

    private func waitUntilFinished(_ model: AskAIModel) async throws {
        for _ in 0..<200 where model.isGenerating {
            try await Task.sleep(for: .milliseconds(5))
        }
        #expect(!model.isGenerating)
    }
}

@MainActor
private final class AskAIKnowledgeProviderStub: AskAIKnowledgeProviding {
    var selectedAskAIDatabaseId = "db_test"
    var selectedAskAIDatabaseTitle = "Test DB"
    var canAskAI = true
    var askAIDatabaseCandidates: [DatabaseSummary] = []
    let sources: [AskAIContextSource]
    let retrievalDelay: Duration?
    private(set) var retrievalCallCount = 0

    init(sources: [AskAIContextSource], retrievalDelay: Duration? = nil) {
        self.sources = sources
        self.retrievalDelay = retrievalDelay
    }

    func selectAskAIDatabase(_ databaseId: String) {
        selectedAskAIDatabaseId = databaseId
    }

    func retrieveAskAISources(question: String, previousQuestion: String?) async throws -> [AskAIContextSource] {
        retrievalCallCount += 1
        if let retrievalDelay {
            try await Task.sleep(for: retrievalDelay)
        }
        return sources
    }

    func openAskAISource(_ path: String) { }
}

private actor AskAIStreamStub: AskAIStreaming {
    let chunks: [String]
    private(set) var callCount = 0

    init(chunks: [String]) {
        self.chunks = chunks
    }

    func contentStream(message: String) async -> AsyncThrowingStream<String, Error> {
        callCount += 1
        return AsyncThrowingStream { continuation in
            for chunk in chunks {
                continuation.yield(chunk)
            }
            continuation.finish()
        }
    }
}

private actor AskAIControlledStreamStub: AskAIStreaming {
    private(set) var callCount = 0
    private(set) var cancellationCount = 0

    func contentStream(message: String) async -> AsyncThrowingStream<String, Error> {
        callCount += 1
        return AsyncThrowingStream { continuation in
            continuation.onTermination = { [weak self] termination in
                guard case .cancelled = termination else { return }
                Task {
                    await self?.recordCancellation()
                }
            }
        }
    }

    private func recordCancellation() {
        cancellationCount += 1
    }
}

private actor AskAIStoreStub: AskAIConversationPersisting {
    private(set) var savedConversations: [AskAIConversation] = []

    func load() async throws -> [AskAIConversation] {
        savedConversations
    }

    func save(_ conversations: [AskAIConversation]) async throws {
        savedConversations = conversations
    }
}
