// Where: mobile/ios/KinicApp/ViewModels/AskAIModel.swift
// What: Main-actor conversation, retrieval trace, grounding, and history coordinator.
// Why: Ask AI views stay declarative while stale responses and unsupported answers are suppressed centrally.

import Foundation
import Observation

@MainActor
@Observable
final class AskAIModel {
    private let knowledgeProvider: AskAIKnowledgeProviding
    private let client: AskAIStreaming
    private let store: AskAIConversationPersisting
    @ObservationIgnored private var generationTask: Task<Void, Never>?
    @ObservationIgnored private var persistenceTask: Task<Void, Never>?
    private var generationID: UUID?

    var conversations: [AskAIConversation] = []
    var currentConversation: AskAIConversation?
    var draft = ""
    var isGenerating = false
    var isLoaded = false
    var errorMessage: String?
    var pendingDatabaseId: String?
    var pendingDatabaseTitle: String?
    var isConfirmingDatabaseChange = false

    init(
        knowledgeProvider: AskAIKnowledgeProviding,
        client: AskAIStreaming,
        store: AskAIConversationPersisting
    ) {
        self.knowledgeProvider = knowledgeProvider
        self.client = client
        self.store = store
    }

    convenience init(appModel: AppModel) {
        self.init(
            knowledgeProvider: appModel,
            client: AskAIClient(endpoint: appModel.configuration.askAIURL),
            store: AskAIConversationStore.live()
        )
    }

    var messages: [AskAIMessage] {
        currentConversation?.messages ?? []
    }

    var currentSources: [AskAISource] {
        messages.reversed().first(where: { !$0.sources.isEmpty })?.sources ?? []
    }

    var databaseTitle: String {
        currentConversation?.databaseTitle ?? knowledgeProvider.selectedAskAIDatabaseTitle
    }

    var canSend: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !isGenerating
            && knowledgeProvider.canAskAI
            && currentConversation != nil
    }

    func load() async {
        guard !isLoaded else {
            syncSelectedDatabase()
            return
        }
        do {
            conversations = try await store.load()
        } catch {
            errorMessage = "Conversation history could not be loaded: \(error.localizedDescription)"
        }
        isLoaded = true
        syncSelectedDatabase()
    }

    func syncSelectedDatabase() {
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
        conversations.removeAll { $0.id == conversation.id }
        if currentConversation?.id == conversation.id {
            newConversation()
        }
        persistConversations()
    }

    func deleteAllConversations() {
        cancelGeneration()
        conversations = []
        newConversation()
        persistConversations()
    }

    func send() {
        let question = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard canSend, !question.isEmpty, var conversation = currentConversation else { return }

        let history = conversation.messages
        let previousQuestion = history.reversed().first(where: { $0.role == .user })?.text
        let userMessage = AskAIMessage(role: .user, text: question)
        let assistantID = UUID()
        let trace = [
            AskAITraceEvent(
                stage: .searching,
                title: "Searching \(conversation.databaseTitle)",
                detail: question,
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
        if history.isEmpty {
            conversation.title = String(question.prefix(60))
        }
        conversation.updatedAt = .now
        currentConversation = conversation
        draft = ""
        errorMessage = nil
        isGenerating = true

        let requestID = UUID()
        generationID = requestID
        generationTask = Task {
            await generateAnswer(
                requestID: requestID,
                assistantID: assistantID,
                question: question,
                previousQuestion: previousQuestion,
                history: history
            )
        }
    }

    func cancelGeneration() {
        generationTask?.cancel()
        generationTask = nil
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
            persistCurrentConversation()
        }
    }

    func openSource(_ source: AskAISource) {
        knowledgeProvider.openAskAISource(source.path)
    }

    private func generateAnswer(
        requestID: UUID,
        assistantID: UUID,
        question: String,
        previousQuestion: String?,
        history: [AskAIMessage]
    ) async {
        do {
            let contexts = try await knowledgeProvider.retrieveAskAISources(
                question: question,
                previousQuestion: previousQuestion
            )
            try Task.checkCancellation()
            guard generationID == requestID else { return }

            setTrace(
                messageID: assistantID,
                events: [
                    AskAITraceEvent(stage: .searching, title: "Searched \(databaseTitle)", detail: question),
                    AskAITraceEvent(
                        stage: .found,
                        title: "Found \(contexts.count) relevant \(contexts.count == 1 ? "note" : "notes")",
                        detail: contexts.map(\.source.path).joined(separator: "\n")
                    ),
                    AskAITraceEvent(
                        stage: .reading,
                        title: "Read \(contexts.count) \(contexts.count == 1 ? "note" : "notes")"
                    )
                ]
            )
            guard !contexts.isEmpty else {
                completeAsInsufficient(messageID: assistantID, sources: [])
                finishGeneration(requestID: requestID)
                return
            }

            appendTrace(
                messageID: assistantID,
                event: AskAITraceEvent(
                    stage: .verifying,
                    title: "Checking whether the notes answer your question",
                    isActive: true
                )
            )
            let prompt = AskAIPromptBuilder.build(
                databaseTitle: databaseTitle,
                question: question,
                history: history,
                sources: contexts
            )
            var decoder = AskAIResponseDecoder()
            let sourceByID = Dictionary(uniqueKeysWithValues: contexts.map { ($0.source.id, $0.source) })
            let stream = await client.contentStream(message: prompt)
            for try await chunk in stream {
                try Task.checkCancellation()
                guard generationID == requestID else { return }
                let outcome = try decoder.append(chunk, validSourceIDs: Set(sourceByID.keys))
                if case let .supported(sourceIDs, answer) = outcome {
                    setGeneratingAnswer(
                        messageID: assistantID,
                        answer: answer,
                        sources: sourceIDs.compactMap { sourceByID[$0] }
                    )
                }
            }
            let finalOutcome = try decoder.finish()
            guard generationID == requestID else { return }
            switch finalOutcome {
            case let .supported(sourceIDs, answer):
                completeSupported(
                    messageID: assistantID,
                    answer: answer,
                    sources: sourceIDs.compactMap { sourceByID[$0] }
                )
            case .insufficient:
                completeAsInsufficient(messageID: assistantID, sources: contexts.map(\.source))
            case .pending:
                throw AskAIResponseError.incompleteResponse
            }
            persistCurrentConversation()
            finishGeneration(requestID: requestID)
        } catch is CancellationError {
            guard generationID == requestID else { return }
            cancelGeneration()
        } catch {
            guard generationID == requestID else { return }
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

    private func setGeneratingAnswer(messageID: UUID, answer: String, sources: [AskAISource]) {
        updateMessage(id: messageID) { message in
            message.text = answer
            message.sources = sources
            message.trace = message.trace.map { event in
                var event = event
                event.isActive = false
                return event
            }
            if !message.trace.contains(where: { $0.stage == .generating }) {
                message.trace.append(
                    AskAITraceEvent(stage: .generating, title: "Writing from verified notes", isActive: true)
                )
            }
        }
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

    private func persistCurrentConversation() {
        guard let conversation = currentConversation, !conversation.messages.isEmpty else { return }
        conversations.removeAll { $0.id == conversation.id }
        conversations.append(conversation)
        conversations.sort { $0.updatedAt > $1.updatedAt }
        persistConversations()
    }

    private func persistConversations() {
        let snapshot = conversations
        let previousTask = persistenceTask
        persistenceTask = Task {
            await previousTask?.value
            do {
                try await store.save(snapshot)
            } catch {
                errorMessage = "Conversation history could not be saved: \(error.localizedDescription)"
            }
        }
    }

    private func finishGeneration(requestID: UUID) {
        guard generationID == requestID else { return }
        generationID = nil
        generationTask = nil
        isGenerating = false
    }
}
