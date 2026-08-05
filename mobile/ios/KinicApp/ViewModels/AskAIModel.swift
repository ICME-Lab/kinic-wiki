// Where: mobile/ios/KinicApp/ViewModels/AskAIModel.swift
// What: Main-actor DB-scoped conversational routing, retrieval, grounding, and history coordinator.
// Why: Ask AI views stay declarative while every conversation remains pinned to one database.

import Foundation
import Observation

@MainActor
@Observable
final class AskAIModel {
    static let maximumQuestionCharacters = AskAIRouter.maximumQuestionCharacters

    private let knowledgeProvider: AskAIKnowledgeProviding
    private let client: AskAICompleting
    private var store: AskAIConversationPersisting
    private let generationTimeout: Duration
    @ObservationIgnored private var generationTask: Task<Void, Never>?
    @ObservationIgnored private var generationTimeoutTask: Task<Void, Never>?
    @ObservationIgnored private var persistenceTask: Task<Void, Never>?
    @ObservationIgnored private var historyContextID = UUID()
    @ObservationIgnored private var historyOperationID: UUID?
    private var generationID: UUID?
    private(set) var historyScope: AskAIHistoryScope
    private(set) var hasStoredConversationData = false

    var conversations: [AskAIConversation] = []
    var currentConversation: AskAIConversation?
    var draft = "" {
        didSet {
            if draft.count > Self.maximumQuestionCharacters {
                draft = String(draft.prefix(Self.maximumQuestionCharacters))
            }
        }
    }
    var isGenerating = false
    var loadState: ConversationLoadState = .loading
    var errorMessage: String?
    var pendingDatabaseId: String?
    var pendingDatabaseTitle: String?
    var isConfirmingDatabaseChange = false
    var isConfirmingHistoryReset = false

    init(
        knowledgeProvider: AskAIKnowledgeProviding,
        client: AskAICompleting,
        store: AskAIConversationPersisting,
        historyScope: AskAIHistoryScope = .guest,
        generationTimeout: Duration = .seconds(120)
    ) {
        self.knowledgeProvider = knowledgeProvider
        self.client = client
        self.store = store
        self.historyScope = historyScope
        self.generationTimeout = generationTimeout
    }

    convenience init(appModel: AppModel) {
        let historyScope = appModel.askAIHistoryScope
        self.init(
            knowledgeProvider: appModel,
            client: AskAIClient(endpoint: appModel.configuration.askAIURL),
            store: AskAIConversationStore.live(scope: historyScope),
            historyScope: historyScope
        )
    }

    var messages: [AskAIMessage] {
        currentConversation?.messages ?? []
    }

    var currentSources: [AskAISource] {
        guard let latestAssistant = messages.last(where: { $0.role == .assistant }),
              latestAssistant.state == .complete else {
            return []
        }
        return latestAssistant.sources
    }

    var databaseTitle: String {
        currentConversation?.databaseTitle ?? knowledgeProvider.selectedAskAIDatabaseTitle
    }

    var canSend: Bool {
        loadState == .loaded
            && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !isGenerating
            && knowledgeProvider.canAskAI
            && currentConversation != nil
    }

    var remainingQuestionCharacters: Int {
        Self.maximumQuestionCharacters - draft.count
    }

    var canDeleteStoredConversationData: Bool {
        !conversations.isEmpty || hasStoredConversationData
    }

    func load() async {
        guard loadState != .loaded else {
            syncSelectedDatabase()
            return
        }
        loadState = .loading
        errorMessage = nil
        let operationID = UUID()
        historyOperationID = operationID
        let targetContextID = historyContextID
        let targetStore = store
        let persistenceBarrier = persistenceTask
        do {
            await persistenceBarrier?.value
            guard isCurrentHistoryOperation(
                contextID: targetContextID,
                operationID: operationID
            ) else { return }
            let loadedConversations = try await targetStore.load()
            let storedConversationDataExists = try await targetStore.hasStoredConversationData()
            guard isCurrentHistoryOperation(
                contextID: targetContextID,
                operationID: operationID
            ) else { return }
            historyOperationID = nil
            conversations = loadedConversations
            hasStoredConversationData = storedConversationDataExists
            let recoveredInterruptedGenerations = recoverInterruptedGenerations()
            loadState = .loaded
            syncSelectedDatabase()
            if recoveredInterruptedGenerations {
                persistConversations()
            }
        } catch {
            guard isCurrentHistoryOperation(
                contextID: targetContextID,
                operationID: operationID
            ) else { return }
            historyOperationID = nil
            let message = "Conversation history could not be loaded: \(error.localizedDescription)"
            conversations = []
            currentConversation = nil
            loadState = .failed(message)
        }
    }

    func retryHistoryLoad() async {
        guard case .failed = loadState else { return }
        await load()
    }

    func resetHistoryAfterLoadFailure() async {
        guard case .failed = loadState else { return }
        let operationID = UUID()
        historyOperationID = operationID
        let targetContextID = historyContextID
        let targetStore = store
        let persistenceBarrier = persistenceTask
        loadState = .loading
        do {
            await persistenceBarrier?.value
            guard isCurrentHistoryOperation(
                contextID: targetContextID,
                operationID: operationID
            ) else { return }
            try await targetStore.resetAfterLoadFailure()
            guard isCurrentHistoryOperation(
                contextID: targetContextID,
                operationID: operationID
            ) else { return }
            historyOperationID = nil
            conversations = []
            currentConversation = nil
            hasStoredConversationData = true
            loadState = .loaded
            syncSelectedDatabase()
        } catch {
            guard isCurrentHistoryOperation(
                contextID: targetContextID,
                operationID: operationID
            ) else { return }
            historyOperationID = nil
            loadState = .failed("Conversation history could not be reset: \(error.localizedDescription)")
        }
    }

    func changeHistoryScope(
        to historyScope: AskAIHistoryScope,
        store: AskAIConversationPersisting
    ) {
        guard historyScope != self.historyScope else { return }
        cancelGeneration(persistFailure: false)
        historyContextID = UUID()
        historyOperationID = nil
        self.historyScope = historyScope
        self.store = store
        conversations = []
        currentConversation = nil
        hasStoredConversationData = false
        draft = ""
        loadState = .loading
        errorMessage = nil
        pendingDatabaseId = nil
        pendingDatabaseTitle = nil
        isConfirmingDatabaseChange = false
        isConfirmingHistoryReset = false
    }

    func syncSelectedDatabase() {
        guard loadState == .loaded else {
            currentConversation = nil
            return
        }
        let databaseId = knowledgeProvider.selectedAskAIDatabaseId
        guard currentConversation?.databaseId != databaseId else {
            return
        }
        cancelGeneration()
        guard !databaseId.isEmpty else {
            currentConversation = nil
            return
        }
        currentConversation = conversations
            .filter { $0.databaseId == databaseId }
            .max { $0.updatedAt < $1.updatedAt }
            ?? makeConversation(databaseId: databaseId, title: knowledgeProvider.selectedAskAIDatabaseTitle)
    }

    func requestDatabaseChange(databaseId: String, title: String) {
        guard databaseId != currentConversation?.databaseId else { return }
        if !messages.isEmpty {
            pendingDatabaseId = databaseId
            pendingDatabaseTitle = title
            isConfirmingDatabaseChange = true
        } else {
            applyDatabaseChange(databaseId: databaseId, title: title)
        }
    }

    func confirmDatabaseChange() {
        guard let databaseId = pendingDatabaseId,
              let title = pendingDatabaseTitle else { return }
        applyDatabaseChange(databaseId: databaseId, title: title)
    }

    func cancelDatabaseChange() {
        pendingDatabaseId = nil
        pendingDatabaseTitle = nil
        isConfirmingDatabaseChange = false
    }

    func newConversation() {
        cancelGeneration()
        let databaseId = knowledgeProvider.selectedAskAIDatabaseId
        guard !databaseId.isEmpty else {
            currentConversation = nil
            return
        }
        currentConversation = makeConversation(
            databaseId: databaseId,
            title: knowledgeProvider.selectedAskAIDatabaseTitle
        )
        errorMessage = nil
    }

    func selectConversation(_ conversation: AskAIConversation) {
        cancelGeneration()
        knowledgeProvider.selectAskAIDatabase(conversation.databaseId)
        currentConversation = conversation
        errorMessage = nil
    }

    func deleteConversation(_ conversation: AskAIConversation) {
        if currentConversation?.id == conversation.id {
            cancelGeneration(persistFailure: false)
            currentConversation = nil
        }
        conversations.removeAll { $0.id == conversation.id }
        if currentConversation == nil {
            startEmptyConversation()
        }
        persistConversations()
    }

    func deleteAllConversations() {
        cancelGeneration(persistFailure: false)
        conversations = []
        currentConversation = nil
        startEmptyConversation()
        deleteAllStoredConversationData()
    }

    func send() {
        let question = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard canSend, !question.isEmpty, var conversation = currentConversation else { return }

        let history = AskAIHistoryFormatter.semanticHistory(conversation.messages)
        let userMessage = AskAIMessage(role: .user, text: question)
        let assistantID = UUID()
        let trace = [
            AskAITraceEvent(
                stage: .generating,
                title: "Preparing a response",
                isActive: true
            )
        ]
        let assistantMessage = AskAIMessage(
            id: assistantID,
            role: .assistant,
            text: "",
            state: .generating,
            trace: trace
        )
        conversation.messages.append(contentsOf: [userMessage, assistantMessage])
        if conversation.messages.count == 2 {
            conversation.title = String(question.prefix(60))
        }
        conversation.updatedAt = .now
        currentConversation = conversation
        draft = ""
        errorMessage = nil
        isGenerating = true
        persistCurrentConversation()

        let requestID = UUID()
        generationID = requestID
        generationTask = Task {
            await generateAnswer(
                requestID: requestID,
                conversationID: conversation.id,
                databaseID: conversation.databaseId,
                databaseTitle: conversation.databaseTitle,
                assistantID: assistantID,
                question: question,
                history: history
            )
        }
        let timeout = generationTimeout
        generationTimeoutTask = Task { [weak self] in
            do {
                try await Task.sleep(for: timeout)
            } catch {
                return
            }
            guard !Task.isCancelled else { return }
            self?.timeoutGeneration(requestID: requestID, assistantID: assistantID)
        }
    }

    func cancelGeneration() {
        cancelGeneration(persistFailure: true)
    }

    private func cancelGeneration(persistFailure: Bool) {
        generationTask?.cancel()
        generationTask = nil
        generationTimeoutTask?.cancel()
        generationTimeoutTask = nil
        generationID = nil
        guard isGenerating else { return }
        isGenerating = false
        if let assistant = messages.last, assistant.role == .assistant, assistant.state == .generating {
            updateMessage(id: assistant.id) { message in
                message.state = .failed
                message.text = "Generation stopped."
                message.trace = message.trace.map { event in
                    var event = event
                    event.isActive = false
                    return event
                }
            }
            if persistFailure {
                persistCurrentConversation()
            }
        }
    }

    func openSource(_ source: AskAISource) {
        guard let databaseID = currentConversation?.databaseId else { return }
        knowledgeProvider.openAskAISource(databaseId: databaseID, path: source.path)
    }

    private func generateAnswer(
        requestID: UUID,
        conversationID: UUID,
        databaseID: String,
        databaseTitle: String,
        assistantID: UUID,
        question: String,
        history: [AskAIMessage]
    ) async {
        do {
            guard continueGeneration(
                requestID: requestID,
                conversationID: conversationID,
                databaseID: databaseID
            ) else { return }
            let routePrompt = AskAIRouter.buildPrompt(
                databaseTitle: databaseTitle,
                question: question,
                history: history
            )
            let routeResponse = try await client.completeContent(
                message: routePrompt,
                timeout: .seconds(30)
            )
            try Task.checkCancellation()
            guard continueGeneration(
                requestID: requestID,
                conversationID: conversationID,
                databaseID: databaseID
            ) else { return }
            let routeRequiresSearch = AskAIRouter.requiresDatabaseSearch(
                question: question,
                history: history
            )
            let routeRequiresConversation = AskAIRouter.requiresConversation(question: question)
            var route: AskAIRoute
            var needsRepair = false
            do {
                route = try AskAIRouter.parse(routeResponse)
                if case .conversation = route, routeRequiresSearch {
                    needsRepair = true
                }
                if case .search = route, routeRequiresConversation {
                    needsRepair = true
                }
            } catch is AskAIRouteError {
                route = .conversation(answer: "")
                needsRepair = true
            }
            if needsRepair {
                let repairResponse = try await client.completeContent(
                    message: AskAIRouter.buildRepairPrompt(
                        databaseTitle: databaseTitle,
                        question: question,
                        history: history
                    ),
                    timeout: .seconds(30)
                )
                try Task.checkCancellation()
                guard continueGeneration(
                    requestID: requestID,
                    conversationID: conversationID,
                    databaseID: databaseID
                ) else { return }
                route = try AskAIRouter.parse(repairResponse)
                if case .conversation = route, routeRequiresSearch {
                    throw AskAIRouteError.invalidFormat
                }
                if case .search = route, routeRequiresConversation {
                    throw AskAIRouteError.invalidFormat
                }
            }
            if case let .conversation(answer) = route {
                completeConversation(messageID: assistantID, answer: answer)
                persistCurrentConversation()
                finishGeneration(requestID: requestID)
                return
            }

            guard case let .search(parsedQueryPlan) = route else {
                throw AskAIRouteError.invalidFormat
            }
            let queryPlan = AskAIQueryPlanner.enriched(
                parsedQueryPlan,
                question: question,
                history: history
            )
            guard knowledgeProvider.canAskAI else {
                completeConversation(
                    messageID: assistantID,
                    answer: "The selected database is unavailable. Choose a readable database to search your notes."
                )
                persistCurrentConversation()
                finishGeneration(requestID: requestID)
                return
            }
            setTrace(
                messageID: assistantID,
                events: [
                    AskAITraceEvent(
                        stage: .searching,
                        title: "Searching notes",
                        isActive: true
                    )
                ]
            )
            let initialRetrieval = try await knowledgeProvider.retrieveAskAISources(
                databaseId: databaseID,
                queryPlan: queryPlan
            )
            try Task.checkCancellation()
            guard continueGeneration(
                requestID: requestID,
                conversationID: conversationID,
                databaseID: databaseID
            ) else { return }
            var retrieval = initialRetrieval
            var searchAttemptCount = 1
            if retrieval.sources.isEmpty {
                let recoveryResponse = try await client.completeContent(
                    message: AskAIQueryPlanner.buildRecoveryPrompt(
                        databaseTitle: databaseTitle,
                        question: question,
                        history: history,
                        previousPlan: queryPlan
                    ),
                    timeout: .seconds(30)
                )
                try Task.checkCancellation()
                guard continueGeneration(
                    requestID: requestID,
                    conversationID: conversationID,
                    databaseID: databaseID
                ) else { return }
                do {
                    let parsedRecoveryPlan = try AskAIQueryPlanner.parseRecovery(
                        recoveryResponse,
                        excluding: queryPlan
                    )
                    let recoveryPlan = AskAIQueryPlanner.enriched(
                        parsedRecoveryPlan,
                        question: question,
                        history: history
                    )
                    let recoveryRetrieval = try await knowledgeProvider.retrieveAskAISources(
                        databaseId: databaseID,
                        queryPlan: recoveryPlan
                    )
                    try Task.checkCancellation()
                    guard continueGeneration(
                        requestID: requestID,
                        conversationID: conversationID,
                        databaseID: databaseID
                    ) else { return }
                    retrieval = AskAIRetrievalResult(
                        searchQueries: initialRetrieval.searchQueries + recoveryRetrieval.searchQueries,
                        candidateCount: initialRetrieval.candidateCount + recoveryRetrieval.candidateCount,
                        sources: recoveryRetrieval.sources
                    )
                    searchAttemptCount = 2
                } catch is AskAIQueryPlanError {
                    // One bounded recovery attempt was consumed; an invalid replacement plan is treated as no match.
                }
            }
            let contexts = retrieval.sources
            let searchDetail = retrieval.searchQueries.joined(separator: "\n")
            let builtPrompt = AskAIPromptBuilder.build(
                databaseTitle: databaseTitle,
                question: question,
                history: history,
                sources: contexts
            )
            let includedContexts = builtPrompt.includedContexts

            setTrace(
                messageID: assistantID,
                events: [
                    AskAITraceEvent(
                        stage: .searching,
                        title: searchAttemptCount == 1
                            ? "Searched with \(retrieval.searchQueries.count) \(retrieval.searchQueries.count == 1 ? "query" : "queries")"
                            : "Retried search with \(retrieval.searchQueries.count) queries",
                        detail: searchDetail
                    ),
                    AskAITraceEvent(
                        stage: .found,
                        title: searchAttemptCount == 1
                            ? "Found \(retrieval.candidateCount) candidate \(retrieval.candidateCount == 1 ? "note" : "notes")"
                            : "Found \(retrieval.candidateCount) candidate matches across 2 searches"
                    ),
                    AskAITraceEvent(
                        stage: .verifying,
                        title: "Verified \(contexts.count) matching \(contexts.count == 1 ? "note" : "notes")",
                        detail: contexts.map(\.source.path).joined(separator: "\n")
                    ),
                    AskAITraceEvent(
                        stage: .reading,
                        title: "Used \(includedContexts.count) \(includedContexts.count == 1 ? "note" : "notes") for answer",
                        detail: includedContexts.map(\.source.path).joined(separator: "\n")
                    )
                ]
            )
            guard !includedContexts.isEmpty else {
                completeAsInsufficient(messageID: assistantID, sources: [])
                persistCurrentConversation()
                finishGeneration(requestID: requestID)
                return
            }
            if AskAIIdentityPolicy.requiresExplicitEvidence(question: question),
               !AskAIIdentityPolicy.hasDirectEvidence(
                question: question,
                sources: includedContexts
               ) {
                completeAsInsufficient(
                    messageID: assistantID,
                    sources: includedContexts.map(\.source)
                )
                persistCurrentConversation()
                finishGeneration(requestID: requestID)
                return
            }

            appendTrace(
                messageID: assistantID,
                event: AskAITraceEvent(
                    stage: .generating,
                    title: "Generating an answer from selected notes",
                    isActive: true
                )
            )
            let sourceByID = Dictionary(
                uniqueKeysWithValues: includedContexts.map { ($0.source.id, $0.source) }
            )
            let response = try await client.completeContent(
                message: builtPrompt.message,
                timeout: .seconds(90)
            )
            try Task.checkCancellation()
            guard continueGeneration(
                requestID: requestID,
                conversationID: conversationID,
                databaseID: databaseID
            ) else { return }
            let finalOutcome = try AskAIResponseDecoder.decode(
                response,
                validSourceIDs: Set(sourceByID.keys)
            )
            switch finalOutcome {
            case let .supported(sourceIDs, answer):
                completeSupported(
                    messageID: assistantID,
                    answer: answer,
                    sources: sourceIDs.compactMap { sourceByID[$0] }
                )
            case .insufficient:
                completeAsInsufficient(messageID: assistantID, sources: includedContexts.map(\.source))
            }
            persistCurrentConversation()
            finishGeneration(requestID: requestID)
        } catch is CancellationError {
            if generationID == requestID {
                cancelGeneration()
            }
        } catch {
            guard continueGeneration(
                requestID: requestID,
                conversationID: conversationID,
                databaseID: databaseID
            ) else { return }
            updateMessage(id: assistantID) { message in
                message.state = .failed
                message.text = "The answer could not be generated. Try again."
                message.trace = message.trace.map { event in
                    var event = event
                    event.isActive = false
                    return event
                }
            }
            errorMessage = error.localizedDescription
            persistCurrentConversation()
            finishGeneration(requestID: requestID)
        }
    }

    private func continueGeneration(
        requestID: UUID,
        conversationID: UUID,
        databaseID: String
    ) -> Bool {
        let isCurrent = generationID == requestID
            && currentConversation?.id == conversationID
            && currentConversation?.databaseId == databaseID
            && knowledgeProvider.selectedAskAIDatabaseId == databaseID
        guard !isCurrent else { return true }
        if generationID == requestID {
            cancelGeneration()
        }
        return false
    }

    private func completeSupported(messageID: UUID, answer: String, sources: [AskAISource]) {
        updateMessage(id: messageID) { message in
            message.text = answer.trimmingCharacters(in: .whitespacesAndNewlines)
            message.sources = sources
            message.state = .complete
            message.trace = message.trace.map { event in
                var event = event
                event.isActive = false
                return event
            }
        }
    }

    private func completeConversation(messageID: UUID, answer: String) {
        updateMessage(id: messageID) { message in
            message.text = answer.trimmingCharacters(in: .whitespacesAndNewlines)
            message.sources = []
            message.state = .complete
            message.trace = []
        }
    }

    private func completeAsInsufficient(messageID: UUID, sources: [AskAISource]) {
        updateMessage(id: messageID) { message in
            message.state = .insufficient
            message.text = "This database does not contain enough information to answer that question. Try different wording or review the possible sources below."
            message.sources = sources
            message.trace = message.trace.map { event in
                var event = event
                event.isActive = false
                return event
            }
        }
    }

    private func setTrace(messageID: UUID, events: [AskAITraceEvent]) {
        updateMessage(id: messageID) { message in
            message.trace = events
        }
    }

    private func appendTrace(messageID: UUID, event: AskAITraceEvent) {
        updateMessage(id: messageID) { message in
            message.trace = message.trace.map { existing in
                var existing = existing
                existing.isActive = false
                return existing
            }
            message.trace.append(event)
        }
    }

    private func updateMessage(id: UUID, mutation: (inout AskAIMessage) -> Void) {
        guard var conversation = currentConversation,
              let index = conversation.messages.firstIndex(where: { $0.id == id }) else { return }
        mutation(&conversation.messages[index])
        conversation.updatedAt = .now
        currentConversation = conversation
    }

    private func applyDatabaseChange(databaseId: String, title: String) {
        cancelGeneration()
        knowledgeProvider.selectAskAIDatabase(databaseId)
        currentConversation = makeConversation(databaseId: databaseId, title: title)
        pendingDatabaseId = nil
        pendingDatabaseTitle = nil
        isConfirmingDatabaseChange = false
        errorMessage = nil
    }

    private func makeConversation(databaseId: String, title: String) -> AskAIConversation {
        AskAIConversation(databaseId: databaseId, databaseTitle: title)
    }

    private func startEmptyConversation() {
        let databaseId = knowledgeProvider.selectedAskAIDatabaseId
        guard !databaseId.isEmpty else {
            currentConversation = nil
            errorMessage = nil
            return
        }
        currentConversation = makeConversation(databaseId: databaseId, title: knowledgeProvider.selectedAskAIDatabaseTitle)
        errorMessage = nil
    }

    private func persistCurrentConversation() {
        guard let conversation = currentConversation, !conversation.messages.isEmpty else { return }
        conversations.removeAll { $0.id == conversation.id }
        conversations.append(conversation)
        conversations.sort { $0.updatedAt > $1.updatedAt }
        persistConversations()
    }

    private func persistConversations() {
        guard loadState == .loaded else { return }
        let snapshot = conversations
        let previousTask = persistenceTask
        let targetContextID = historyContextID
        let targetStore = store
        persistenceTask = Task {
            await previousTask?.value
            do {
                try await targetStore.save(snapshot)
                guard historyContextID == targetContextID else { return }
                hasStoredConversationData = true
            } catch {
                guard historyContextID == targetContextID else { return }
                errorMessage = "Conversation history could not be saved: \(error.localizedDescription)"
            }
        }
    }

    private func deleteAllStoredConversationData() {
        guard loadState == .loaded else { return }
        let previousTask = persistenceTask
        let targetContextID = historyContextID
        let targetStore = store
        persistenceTask = Task {
            await previousTask?.value
            do {
                try await targetStore.deleteAllStoredConversationData()
                guard historyContextID == targetContextID else { return }
                hasStoredConversationData = false
                errorMessage = nil
            } catch {
                guard historyContextID == targetContextID else { return }
                errorMessage = "Conversation history could not be deleted: \(error.localizedDescription)"
            }
        }
    }

    private func isCurrentHistoryOperation(contextID: UUID, operationID: UUID) -> Bool {
        historyContextID == contextID && historyOperationID == operationID
    }

    private func recoverInterruptedGenerations() -> Bool {
        var recovered = false
        for conversationIndex in conversations.indices {
            for messageIndex in conversations[conversationIndex].messages.indices {
                var message = conversations[conversationIndex].messages[messageIndex]
                guard message.role == .assistant, message.state == .generating else {
                    continue
                }
                message.state = .failed
                message.text = "Generation was interrupted."
                message.sources = []
                message.trace = message.trace.map { event in
                    var event = event
                    event.isActive = false
                    return event
                }
                conversations[conversationIndex].messages[messageIndex] = message
                recovered = true
            }
        }
        return recovered
    }

    private func timeoutGeneration(requestID: UUID, assistantID: UUID) {
        guard generationID == requestID else { return }
        generationTask?.cancel()
        updateMessage(id: assistantID) { message in
            message.state = .failed
            message.text = "The answer took too long. Try again."
            message.sources = []
            message.trace = message.trace.map { event in
                var event = event
                event.isActive = false
                return event
            }
        }
        errorMessage = "Kinic AI did not finish within 120 seconds. Try again."
        persistCurrentConversation()
        finishGeneration(requestID: requestID)
    }

    private func finishGeneration(requestID: UUID) {
        guard generationID == requestID else { return }
        generationID = nil
        generationTask = nil
        generationTimeoutTask?.cancel()
        generationTimeoutTask = nil
        isGenerating = false
    }
}
