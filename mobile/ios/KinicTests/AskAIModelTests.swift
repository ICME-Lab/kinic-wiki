// Where: mobile/ios/KinicTests/AskAIModelTests.swift
// What: End-to-end two-stage Ask AI state, call-order, fallback, and persistence tests.
// Why: Query generation is mandatory and no model text may be shown before final validation.

import Foundation
import Testing
@testable import Kinic

@MainActor
struct AskAIModelTests {
    @Test
    func currentSourcesUsesOnlyLatestCompletedAssistantSources() {
        let previousSource = contextSource(id: "S1").source
        let latestSource = contextSource(id: "S2").source
        let model = AskAIModel(
            knowledgeProvider: AskAIKnowledgeProviderStub(sources: []),
            client: AskAICompletionStub(responses: []),
            store: AskAIStoreStub()
        )
        model.currentConversation = AskAIConversation(
            databaseId: "db_test",
            databaseTitle: "Test DB",
            messages: [
                AskAIMessage(role: .assistant, text: "Previous", sources: [previousSource]),
                AskAIMessage(role: .assistant, text: "Latest", sources: [latestSource])
            ]
        )

        #expect(model.currentSources == [latestSource])
    }

    @Test(arguments: [
        AskAIMessageState.generating,
        AskAIMessageState.failed,
        AskAIMessageState.insufficient
    ])
    func currentSourcesDoesNotFallBackFromAnIncompleteLatestAssistant(
        _ latestState: AskAIMessageState
    ) {
        let previousSource = contextSource(id: "S1").source
        let latestCandidate = contextSource(id: "S2").source
        let model = AskAIModel(
            knowledgeProvider: AskAIKnowledgeProviderStub(sources: []),
            client: AskAICompletionStub(responses: []),
            store: AskAIStoreStub()
        )
        model.currentConversation = AskAIConversation(
            databaseId: "db_test",
            databaseTitle: "Test DB",
            messages: [
                AskAIMessage(role: .assistant, text: "Previous", sources: [previousSource]),
                AskAIMessage(
                    role: .assistant,
                    text: "Latest",
                    state: latestState,
                    sources: [latestCandidate]
                )
            ]
        )

        #expect(model.currentSources.isEmpty)
    }

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
    func sourceExcludedFromPromptIsRejectedByTheAnswerDecoder() async throws {
        let sources = (1...2).map { index in
            AskAIContextSource(
                source: AskAISource(
                    id: "S\(index)",
                    path: "/" + String(repeating: "\(index)", count: 7_000),
                    excerpt: String(repeating: "e", count: 300),
                    score: Float(index),
                    matchReasons: []
                ),
                content: String(repeating: "c", count: 3_000)
            )
        }
        let client = AskAICompletionStub(responses: [
            .value("<answer>question</answer>"),
            .value("<sources>S2</sources><answer>Excluded source</answer>")
        ])
        let model = AskAIModel(
            knowledgeProvider: AskAIKnowledgeProviderStub(sources: sources),
            client: client,
            store: AskAIStoreStub()
        )
        await model.load()

        model.draft = "Question"
        model.send()
        try await waitUntilFinished(model)

        let prompts = await client.messages
        #expect(prompts[1].contains("SOURCE S1"))
        #expect(!prompts[1].contains("SOURCE S2"))
        #expect(model.messages.last?.state == .failed)
        #expect(model.messages.last?.text != "Excluded source")
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
    func failedAndInterruptedTurnsAreExcludedFromBothPrompts() async throws {
        let prior = AskAIConversation(
            databaseId: "db_test",
            databaseTitle: "Test DB",
            messages: [
                AskAIMessage(role: .user, text: "COMPLETED USER"),
                AskAIMessage(role: .assistant, text: "COMPLETED ASSISTANT", state: .complete),
                AskAIMessage(role: .user, text: "CANCELLED USER"),
                AskAIMessage(role: .assistant, text: "Generation stopped.", state: .failed),
                AskAIMessage(role: .user, text: "TIMEOUT USER"),
                AskAIMessage(role: .assistant, text: "The answer took too long. Try again.", state: .failed),
                AskAIMessage(role: .user, text: "ERROR USER"),
                AskAIMessage(
                    role: .assistant,
                    text: "The answer could not be generated. Try again.",
                    state: .failed
                ),
                AskAIMessage(role: .user, text: "INTERRUPTED USER"),
                AskAIMessage(role: .assistant, text: "", state: .generating)
            ]
        )
        let client = AskAICompletionStub(responses: [
            .value("<answer>question</answer>"),
            .value("<sources>S1</sources><answer>Grounded answer.</answer>")
        ])
        let model = AskAIModel(
            knowledgeProvider: AskAIKnowledgeProviderStub(sources: [contextSource()]),
            client: client,
            store: AskAIStoreStub(savedConversations: [prior])
        )
        await model.load()

        model.draft = "Current question"
        model.send()
        try await waitUntilFinished(model)

        let prompts = await client.messages
        #expect(prompts.count == 2)
        for prompt in prompts {
            #expect(prompt.contains("COMPLETED USER"))
            #expect(prompt.contains("COMPLETED ASSISTANT"))
            #expect(!prompt.contains("CANCELLED USER"))
            #expect(!prompt.contains("Generation stopped."))
            #expect(!prompt.contains("TIMEOUT USER"))
            #expect(!prompt.contains("The answer took too long."))
            #expect(!prompt.contains("ERROR USER"))
            #expect(!prompt.contains("The answer could not be generated."))
            #expect(!prompt.contains("INTERRUPTED USER"))
        }
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

    @Test
    func loadFailureBlocksSendingAndSavingUntilRetrySucceeds() async throws {
        let sentinel = AskAIConversation(databaseId: "db_test", databaseTitle: "Sentinel")
        let store = AskAIStoreStub(savedConversations: [sentinel], loadFailuresRemaining: 1)
        let model = AskAIModel(
            knowledgeProvider: AskAIKnowledgeProviderStub(sources: []),
            client: AskAICompletionStub(responses: []),
            store: store
        )

        await model.load()
        model.draft = "Must not send"
        model.send()

        guard case .failed = model.loadState else {
            Issue.record("Expected a failed history load state")
            return
        }
        #expect(!model.canSend)
        #expect(await store.saveCount == 0)
        #expect(await store.savedConversations.map(\.id) == [sentinel.id])

        await model.retryHistoryLoad()
        model.draft = "Allowed after retry"

        #expect(model.loadState == .loaded)
        #expect(model.canSend)
        #expect(model.conversations.map(\.id) == [sentinel.id])
    }

    @Test
    func resetAfterLoadFailureUsesExplicitStoreRecovery() async {
        let sentinel = AskAIConversation(databaseId: "db_test", databaseTitle: "Sentinel")
        let store = AskAIStoreStub(savedConversations: [sentinel], loadFailuresRemaining: 1)
        let model = AskAIModel(
            knowledgeProvider: AskAIKnowledgeProviderStub(sources: []),
            client: AskAICompletionStub(responses: []),
            store: store
        )

        await model.load()
        await model.resetHistoryAfterLoadFailure()

        #expect(model.loadState == .loaded)
        #expect(model.conversations.isEmpty)
        #expect(await store.resetCount == 1)
        #expect(await store.savedConversations.isEmpty)
    }

    @Test
    func deletingActiveConversationDuringGenerationDoesNotReinsertIt() async throws {
        let client = AskAICompletionStub(responses: [
            .delayed("<answer>late query</answer>", .seconds(60))
        ])
        let store = AskAIStoreStub()
        let model = AskAIModel(
            knowledgeProvider: AskAIKnowledgeProviderStub(sources: []),
            client: client,
            store: store
        )
        await model.load()
        model.draft = "Question"
        model.send()
        try await waitForCallCount(client, count: 1)
        let deleted = try #require(model.currentConversation)

        model.deleteConversation(deleted)
        try await waitForConversationToDisappear(store, id: deleted.id)

        #expect(!model.conversations.contains { $0.id == deleted.id })
        #expect(model.currentConversation?.id != deleted.id)
        #expect(!(await store.savedConversations.contains { $0.id == deleted.id }))
        #expect(await client.cancellationCount == 1)
    }

    @Test
    func changingPrincipalScopeClearsHistoryAndKeepsDelayedWorkInOldStore() async throws {
        let scopeA = AskAIHistoryScope(principal: "aaaaa-aa")
        let scopeB = AskAIHistoryScope(principal: "bbbbb-bb")
        let storeA = AskAIStoreStub()
        let storeB = AskAIStoreStub()
        let client = AskAICompletionStub(responses: [
            .delayed("<answer>late query</answer>", .seconds(60))
        ])
        let model = AskAIModel(
            knowledgeProvider: AskAIKnowledgeProviderStub(sources: []),
            client: client,
            store: storeA,
            historyScope: scopeA
        )
        await model.load()
        model.draft = "A private question"
        model.send()
        try await waitForCallCount(client, count: 1)
        let conversationA = try #require(model.currentConversation)

        model.changeHistoryScope(to: scopeB, store: storeB)

        #expect(model.conversations.isEmpty)
        #expect(model.currentConversation == nil)
        #expect(model.draft.isEmpty)
        #expect(model.loadState == .loading)

        await model.load()
        try await Task.sleep(for: .milliseconds(20))

        #expect(model.loadState == .loaded)
        #expect(!model.conversations.contains { $0.id == conversationA.id })
        #expect(!(await storeB.savedConversations.contains { $0.id == conversationA.id }))
        #expect(await client.cancellationCount == 1)
    }

    @Test
    func staleLoadSuccessCannotOverwriteReenteredPrincipalContext() async throws {
        let scopeA = AskAIHistoryScope(principal: "aaaaa-aa")
        let scopeB = AskAIHistoryScope(principal: "bbbbb-bb")
        let staleConversation = AskAIConversation(databaseId: "db_test", databaseTitle: "Stale A")
        let currentConversation = AskAIConversation(databaseId: "db_test", databaseTitle: "Current A")
        let staleStoreA = AskAIControllableStoreStub(suspendsLoad: true)
        let model = AskAIModel(
            knowledgeProvider: AskAIKnowledgeProviderStub(sources: []),
            client: AskAICompletionStub(responses: []),
            store: staleStoreA,
            historyScope: scopeA
        )
        let staleLoadTask = Task { await model.load() }
        try await waitForPendingLoad(staleStoreA)

        model.changeHistoryScope(to: scopeB, store: AskAIStoreStub())
        model.changeHistoryScope(
            to: scopeA,
            store: AskAIStoreStub(savedConversations: [currentConversation])
        )
        await model.load()

        await staleStoreA.resumeLoad(with: [staleConversation])
        await staleLoadTask.value

        #expect(model.loadState == .loaded)
        #expect(model.conversations.map(\.id) == [currentConversation.id])
    }

    @Test
    func staleLoadFailureCannotFailReenteredPrincipalContext() async throws {
        let scopeA = AskAIHistoryScope(principal: "aaaaa-aa")
        let scopeB = AskAIHistoryScope(principal: "bbbbb-bb")
        let currentConversation = AskAIConversation(databaseId: "db_test", databaseTitle: "Current A")
        let staleStoreA = AskAIControllableStoreStub(suspendsLoad: true)
        let model = AskAIModel(
            knowledgeProvider: AskAIKnowledgeProviderStub(sources: []),
            client: AskAICompletionStub(responses: []),
            store: staleStoreA,
            historyScope: scopeA
        )
        let staleLoadTask = Task { await model.load() }
        try await waitForPendingLoad(staleStoreA)

        model.changeHistoryScope(to: scopeB, store: AskAIStoreStub())
        model.changeHistoryScope(
            to: scopeA,
            store: AskAIStoreStub(savedConversations: [currentConversation])
        )
        await model.load()

        await staleStoreA.failLoad()
        await staleLoadTask.value

        #expect(model.loadState == .loaded)
        #expect(model.conversations.map(\.id) == [currentConversation.id])
    }

    @Test
    func staleResetCannotClearReenteredPrincipalContext() async throws {
        let scopeA = AskAIHistoryScope(principal: "aaaaa-aa")
        let scopeB = AskAIHistoryScope(principal: "bbbbb-bb")
        let currentConversation = AskAIConversation(databaseId: "db_test", databaseTitle: "Current A")
        let staleStoreA = AskAIControllableStoreStub(loadFails: true, suspendsReset: true)
        let model = AskAIModel(
            knowledgeProvider: AskAIKnowledgeProviderStub(sources: []),
            client: AskAICompletionStub(responses: []),
            store: staleStoreA,
            historyScope: scopeA
        )
        await model.load()
        let staleResetTask = Task { await model.resetHistoryAfterLoadFailure() }
        try await waitForPendingReset(staleStoreA)

        model.changeHistoryScope(to: scopeB, store: AskAIStoreStub())
        model.changeHistoryScope(
            to: scopeA,
            store: AskAIStoreStub(savedConversations: [currentConversation])
        )
        await model.load()

        await staleStoreA.resumeReset()
        await staleResetTask.value

        #expect(model.loadState == .loaded)
        #expect(model.conversations.map(\.id) == [currentConversation.id])
    }

    @Test
    func staleSaveFailureCannotSetErrorInReenteredPrincipalContext() async throws {
        let scopeA = AskAIHistoryScope(principal: "aaaaa-aa")
        let scopeB = AskAIHistoryScope(principal: "bbbbb-bb")
        let staleStoreA = AskAIControllableStoreStub(suspendsSave: true)
        let client = AskAICompletionStub(responses: [
            .delayed("<answer>late query</answer>", .seconds(60))
        ])
        let model = AskAIModel(
            knowledgeProvider: AskAIKnowledgeProviderStub(sources: []),
            client: client,
            store: staleStoreA,
            historyScope: scopeA
        )
        await model.load()
        model.draft = "A private question"
        model.send()
        try await waitForPendingSave(staleStoreA)

        model.changeHistoryScope(to: scopeB, store: AskAIStoreStub())
        model.changeHistoryScope(to: scopeA, store: AskAIStoreStub())
        let reenteredLoad = Task { await model.load() }

        await staleStoreA.failSave()
        await reenteredLoad.value
        try await waitForSaveCompletion(staleStoreA)

        #expect(model.loadState == .loaded)
        #expect(model.errorMessage == nil)
    }

    @Test
    func reenteredPrincipalSaveWaitsForEarlierSaveToFinish() async throws {
        let scopeA = AskAIHistoryScope(principal: "aaaaa-aa")
        let scopeB = AskAIHistoryScope(principal: "bbbbb-bb")
        let staleStoreA = AskAIControllableStoreStub(suspendsSave: true)
        let currentConversation = AskAIConversation(databaseId: "db_test", databaseTitle: "Current A")
        let currentStoreA = AskAIStoreStub(savedConversations: [currentConversation])
        let client = AskAICompletionStub(responses: [
            .delayed("<answer>late query</answer>", .seconds(60))
        ])
        let model = AskAIModel(
            knowledgeProvider: AskAIKnowledgeProviderStub(sources: []),
            client: client,
            store: staleStoreA,
            historyScope: scopeA
        )
        await model.load()
        model.draft = "A private question"
        model.send()
        try await waitForPendingSave(staleStoreA)

        model.changeHistoryScope(to: scopeB, store: AskAIStoreStub())
        model.changeHistoryScope(to: scopeA, store: currentStoreA)
        let reenteredLoad = Task { await model.load() }
        try await Task.sleep(for: .milliseconds(20))

        #expect(await currentStoreA.saveCount == 0)

        await staleStoreA.resumeSave()
        await reenteredLoad.value
        model.deleteAllConversations()
        try await waitForSaveCount(currentStoreA, count: 1)

        #expect(await currentStoreA.savedConversations.isEmpty)
    }

    @Test
    func reenteredPrincipalLoadWaitsForEarlierSaveOnSharedBacking() async throws {
        let scopeA = AskAIHistoryScope(principal: "aaaaa-aa")
        let scopeB = AskAIHistoryScope(principal: "bbbbb-bb")
        let backingA = AskAISharedStoreBacking(suspendsNextSave: true)
        let firstStoreA = AskAISharedStoreHandle(backing: backingA)
        let reenteredStoreA = AskAISharedStoreHandle(backing: backingA)
        let client = AskAICompletionStub(responses: [
            .delayed("<answer>late query</answer>", .seconds(60))
        ])
        let model = AskAIModel(
            knowledgeProvider: AskAIKnowledgeProviderStub(sources: []),
            client: client,
            store: firstStoreA,
            historyScope: scopeA
        )
        await model.load()
        model.draft = "A private question"
        model.send()
        try await waitForPendingSave(backingA)
        let savedConversationID = try #require(model.currentConversation?.id)

        model.changeHistoryScope(to: scopeB, store: AskAIStoreStub())
        model.changeHistoryScope(to: scopeA, store: reenteredStoreA)
        let reenteredLoad = Task { await model.load() }
        try await Task.sleep(for: .milliseconds(20))

        #expect(await backingA.loadCount == 1)

        await backingA.resumeSave()
        await reenteredLoad.value

        #expect(await backingA.loadCount == 2)
        #expect(model.conversations.map(\.id) == [savedConversationID])
    }

    @Test
    func resetWaitsForPendingSaveBeforeClearingSharedBacking() async throws {
        let backing = AskAISharedStoreBacking(suspendsNextSave: true)
        let store = AskAISharedStoreHandle(backing: backing)
        let client = AskAICompletionStub(responses: [
            .delayed("<answer>late query</answer>", .seconds(60))
        ])
        let model = AskAIModel(
            knowledgeProvider: AskAIKnowledgeProviderStub(sources: []),
            client: client,
            store: store
        )
        await model.load()
        model.draft = "Question"
        model.send()
        try await waitForPendingSave(backing)
        model.loadState = .failed("Injected load failure")
        model.cancelGeneration()

        let reset = Task { await model.resetHistoryAfterLoadFailure() }
        try await Task.sleep(for: .milliseconds(20))

        #expect(await backing.resetCount == 0)

        await backing.resumeSave()
        await reset.value

        #expect(await backing.resetCount == 1)
        #expect(await backing.savedConversations.isEmpty)
        #expect(model.loadState == .loaded)
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

    private func waitForConversationToDisappear(_ store: AskAIStoreStub, id: UUID) async throws {
        for _ in 0..<200 {
            let saveCount = await store.saveCount
            let containsConversation = await store.savedConversations.contains { $0.id == id }
            if saveCount >= 2, !containsConversation { return }
            try await Task.sleep(for: .milliseconds(5))
        }
        Issue.record("Expected deleted conversation to stay absent")
    }

    private func waitForPendingLoad(_ store: AskAIControllableStoreStub) async throws {
        for _ in 0..<200 {
            if await store.hasPendingLoad { return }
            try await Task.sleep(for: .milliseconds(5))
        }
        Issue.record("Expected a pending history load")
    }

    private func waitForPendingReset(_ store: AskAIControllableStoreStub) async throws {
        for _ in 0..<200 {
            if await store.hasPendingReset { return }
            try await Task.sleep(for: .milliseconds(5))
        }
        Issue.record("Expected a pending history reset")
    }

    private func waitForPendingSave(_ store: AskAIControllableStoreStub) async throws {
        for _ in 0..<200 {
            if await store.hasPendingSave { return }
            try await Task.sleep(for: .milliseconds(5))
        }
        Issue.record("Expected a pending history save")
    }

    private func waitForPendingSave(_ backing: AskAISharedStoreBacking) async throws {
        for _ in 0..<200 {
            if await backing.hasPendingSave { return }
            try await Task.sleep(for: .milliseconds(5))
        }
        Issue.record("Expected a pending shared-backing save")
    }

    private func waitForSaveCompletion(_ store: AskAIControllableStoreStub) async throws {
        for _ in 0..<200 {
            if await store.saveCompletionCount == 1 { return }
            try await Task.sleep(for: .milliseconds(5))
        }
        Issue.record("Expected the history save to finish")
    }

    private func waitForSaveCount(_ store: AskAIStoreStub, count: Int) async throws {
        for _ in 0..<200 {
            if await store.saveCount == count { return }
            try await Task.sleep(for: .milliseconds(5))
        }
        Issue.record("Expected \(count) history saves")
    }

    private func contextSource(id: String = "S1") -> AskAIContextSource {
        AskAIContextSource(
            source: AskAISource(
                id: id,
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
    private var loadFailuresRemaining: Int
    private(set) var saveCount = 0
    private(set) var resetCount = 0

    init(savedConversations: [AskAIConversation] = [], loadFailuresRemaining: Int = 0) {
        self.savedConversations = savedConversations
        self.loadFailuresRemaining = loadFailuresRemaining
    }

    func load() async throws -> [AskAIConversation] {
        if loadFailuresRemaining > 0 {
            loadFailuresRemaining -= 1
            throw AskAIStoreStubError.loadFailed
        }
        return savedConversations
    }

    func save(_ conversations: [AskAIConversation]) async throws {
        saveCount += 1
        savedConversations = conversations
    }

    func resetAfterLoadFailure() async throws {
        resetCount += 1
        savedConversations = []
    }
}

private actor AskAISharedStoreBacking {
    private var shouldSuspendSave: Bool
    private var saveContinuation: CheckedContinuation<Void, Never>?
    private(set) var savedConversations: [AskAIConversation] = []
    private(set) var loadCount = 0
    private(set) var resetCount = 0

    init(suspendsNextSave: Bool) {
        shouldSuspendSave = suspendsNextSave
    }

    var hasPendingSave: Bool { saveContinuation != nil }

    func load() -> [AskAIConversation] {
        loadCount += 1
        return savedConversations
    }

    func save(_ conversations: [AskAIConversation]) async {
        if shouldSuspendSave {
            shouldSuspendSave = false
            await withCheckedContinuation { continuation in
                saveContinuation = continuation
            }
        }
        savedConversations = conversations
    }

    func reset() {
        resetCount += 1
        savedConversations = []
    }

    func resumeSave() {
        let continuation = saveContinuation
        saveContinuation = nil
        continuation?.resume()
    }
}

private actor AskAISharedStoreHandle: AskAIConversationPersisting {
    private let backing: AskAISharedStoreBacking

    init(backing: AskAISharedStoreBacking) {
        self.backing = backing
    }

    func load() async throws -> [AskAIConversation] {
        await backing.load()
    }

    func save(_ conversations: [AskAIConversation]) async throws {
        await backing.save(conversations)
    }

    func resetAfterLoadFailure() async throws {
        await backing.reset()
    }
}

private actor AskAIControllableStoreStub: AskAIConversationPersisting {
    private let loadFails: Bool
    private let suspendsLoad: Bool
    private let suspendsSave: Bool
    private let suspendsReset: Bool
    private var loadContinuation: CheckedContinuation<[AskAIConversation], any Error>?
    private var saveContinuation: CheckedContinuation<Void, any Error>?
    private var resetContinuation: CheckedContinuation<Void, any Error>?
    private(set) var saveCompletionCount = 0

    init(
        loadFails: Bool = false,
        suspendsLoad: Bool = false,
        suspendsSave: Bool = false,
        suspendsReset: Bool = false
    ) {
        self.loadFails = loadFails
        self.suspendsLoad = suspendsLoad
        self.suspendsSave = suspendsSave
        self.suspendsReset = suspendsReset
    }

    var hasPendingLoad: Bool { loadContinuation != nil }
    var hasPendingSave: Bool { saveContinuation != nil }
    var hasPendingReset: Bool { resetContinuation != nil }

    func load() async throws -> [AskAIConversation] {
        if suspendsLoad {
            return try await withCheckedThrowingContinuation { continuation in
                loadContinuation = continuation
            }
        }
        if loadFails {
            throw AskAIStoreStubError.loadFailed
        }
        return []
    }

    func save(_ conversations: [AskAIConversation]) async throws {
        defer { saveCompletionCount += 1 }
        if suspendsSave {
            try await withCheckedThrowingContinuation { continuation in
                saveContinuation = continuation
            }
        }
    }

    func resetAfterLoadFailure() async throws {
        if suspendsReset {
            try await withCheckedThrowingContinuation { continuation in
                resetContinuation = continuation
            }
        }
    }

    func resumeLoad(with conversations: [AskAIConversation]) {
        let continuation = loadContinuation
        loadContinuation = nil
        continuation?.resume(returning: conversations)
    }

    func failLoad() {
        let continuation = loadContinuation
        loadContinuation = nil
        continuation?.resume(throwing: AskAIStoreStubError.loadFailed)
    }

    func failSave() {
        let continuation = saveContinuation
        saveContinuation = nil
        continuation?.resume(throwing: AskAIStoreStubError.saveFailed)
    }

    func resumeSave() {
        let continuation = saveContinuation
        saveContinuation = nil
        continuation?.resume()
    }

    func resumeReset() {
        let continuation = resetContinuation
        resetContinuation = nil
        continuation?.resume()
    }
}

private enum AskAIStoreStubError: Error {
    case loadFailed
    case saveFailed
}
