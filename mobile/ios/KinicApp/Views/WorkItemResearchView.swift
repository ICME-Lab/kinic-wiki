import SwiftUI

/// A foreground research loop using the existing Ask AI service and account-scoped history.
struct WorkItemResearchView: View {
    @Bindable var appModel: AppModel
    @Bindable var workItems: WorkItemModel
    @Bindable var assistant: AskAIModel
    let detail: WorkItemDetail
    let context: WorkItemResearchContext
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @State private var request = ""
    @State private var conversationID: UUID?
    @State private var prepared = false
    @State private var publishing = false
    @State private var starting = false
    @State private var allowPendingStart = true
    @State private var publication: WorkItemModel.ResearchPublication?
    @State private var draftOwner = UUID()
    @State private var startError: String?
    @State private var initialRequest = ""
    @State private var confirmingDiscard = false
    @State private var sourceToOpen: AskAISource?

    private var conversation: AskAIConversation? {
        guard let current = assistant.currentConversation, current.id == conversationID,
              let reference = current.workItemResearch,
              reference.belongsTo(principal: context.principal, databaseId: context.databaseId, itemId: context.itemId)
        else { return nil }
        return current
    }
    private var finishedAnswer: AskAIMessage? {
        guard let message = conversation?.messages.last, WorkItemResearch.isFinished(message) else { return nil }
        return message
    }
    private var running: Bool { conversation != nil && assistant.isGenerating }
    private var hasEditedRequest: Bool { !request.isEmpty && request != initialRequest }
    private var requestIsValid: Bool {
        !request.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && AskAIQuestionLimit.contains(request)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text(detail.item.title).font(.headline)
                    Text("Ask AI searches this Wiki database and saves its result with sources as a comment. Other database members can read it. You decide when the work item is complete.")
                        .font(.subheadline).foregroundStyle(.secondary)
                    if !prepared {
                        ProgressView("Loading research history…")
                    } else {
                        ForEach(conversation?.messages ?? []) { message in
                            VStack(alignment: .leading, spacing: 8) {
                                Text(message.role == .user ? "Request" : "AI research")
                                    .font(.headline)
                                MarkdownContent(markdown: message.text)
                                if message.state == .generating { ProgressView("Researching…") }
                                if message.state == .failed {
                                    Text("This attempt did not finish.")
                                        .font(.footnote).foregroundStyle(.secondary)
                                    if conversation?.messages.last?.id == message.id,
                                       let question = conversation?.messages.last(where: { $0.role == .user })?.text {
                                        Button("Edit and retry") { request = question; initialRequest = "" }
                                            .frame(minHeight: 44)
                                    }
                                }
                                if !message.sources.isEmpty {
                                    AskAISourcesView(heading: message.state == .insufficient ? "Possible sources" : "Sources",
                                        sources: message.sources, openSource: { source in
                                            sourceToOpen = source
                                            if hasEditedRequest { confirmingDiscard = true } else { close() }
                                        })
                                        .disabled(running || publishing)
                                }
                            }
                            Divider()
                        }
                        publicationStatus
                        if starting { ProgressView("Preparing research…") }
                        if running {
                            Text("Keep the app open until research finishes. The result remains available in Ask AI history.")
                                .font(.footnote).foregroundStyle(.secondary)
                            Button("Stop research", systemImage: "stop.circle") { assistant.cancelGeneration() }
                                .frame(minHeight: 44)
                        } else {
                            Text(conversation == nil ? "Review the request" : "Follow-up request").font(.headline)
                            TextField("What would you like to find out?", text: $request, axis: .vertical)
                                .lineLimit(3...8)
                                .textFieldStyle(.roundedBorder)
                                .accessibilityIdentifier("research.request")
                                .disabled(starting)
                            Text("\(request.count) / \(AskAIModel.maximumQuestionCharacters) characters")
                                .font(.caption).foregroundStyle(.secondary)
                            Text("The request and relevant Wiki excerpts are processed by the same AI service used by Ask AI.")
                                .font(.footnote).foregroundStyle(.secondary)
                            Button(conversation == nil ? "Start research" : "Send follow-up", systemImage: "sparkle.magnifyingglass", action: send)
                                .buttonStyle(.borderedProminent)
                                .disabled(!requestIsValid || starting || publishing || publication == .failed || assistant.isGenerating || assistant.isSynchronizingWorker)
                                .accessibilityIdentifier("research.start")
                        }
                        if let error = startError ?? assistant.errorMessage {
                            Text(error).foregroundStyle(.red).font(.footnote)
                        }
                    }
                }
                .padding(KinicDesign.screenPadding)
            }
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle("Research")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Close") {
                        sourceToOpen = nil
                        if hasEditedRequest { confirmingDiscard = true } else { close() }
                    }.disabled(starting || running || publishing)
                        .accessibilityIdentifier("research.close")
                }
            }
        }
        .interactiveDismissDisabled(starting || running || publishing || hasEditedRequest)
        .alert("Discard the unsent request?", isPresented: $confirmingDiscard) {
            Button("Discard request", role: .destructive) { close() }
            Button("Keep editing", role: .cancel) {}
        }
        .task { await prepare() }
        .task(id: finishedAnswer?.id) { await publish() }
        .onChange(of: appModel.principalText) { _, principal in
            if principal != context.principal { leaveChangedContext() }
        }
        .onChange(of: appModel.selectedDatabaseId) { _, databaseId in
            if databaseId != context.databaseId { leaveChangedContext() }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .background {
                allowPendingStart = false
                if running { assistant.cancelGeneration() }
            }
        }
        .onAppear { appModel.setWorkItemDraftActive(true, owner: draftOwner) }
        .onDisappear {
            allowPendingStart = false
            if running { assistant.cancelGeneration() }
            appModel.setWorkItemDraftActive(false, owner: draftOwner)
        }
    }

    @ViewBuilder private var publicationStatus: some View {
        if publishing {
            ProgressView("Saving result…")
        } else if let publication {
            switch publication {
            case .shared:
                Label("Result saved to this work item. Review it before closing the item.", systemImage: "checkmark.circle")
            case .queued:
                Label("Result saved on this device. Use Send under Unsent changes to share it.", systemImage: "tray")
            case .failed:
                Text("The result could not be attached. Keep this screen open and retry saving it.")
                Button("Retry saving result") { Task { await publish() } }.frame(minHeight: 44)
            }
        }
    }

    private func prepare() async {
        guard appModel.principalText == context.principal, appModel.selectedDatabaseId == context.databaseId else { return }
        assistant.changeHistoryScope(to: appModel.askAIHistoryScope,
            store: AskAIConversationStore.live(scope: appModel.askAIHistoryScope))
        await assistant.load()
        guard appModel.principalText == context.principal, appModel.selectedDatabaseId == context.databaseId else { return }
        if !assistant.isGenerating, assistant.draft.isEmpty,
           let previous = assistant.conversations.first(where: {
               $0.workItemResearch?.belongsTo(principal: context.principal, databaseId: context.databaseId, itemId: context.itemId) == true
           }) {
            assistant.selectConversation(previous)
            conversationID = previous.id
        } else {
            request = WorkItemResearch.prompt(for: detail.item)
            initialRequest = request
        }
        prepared = true
    }

    private func send() {
        guard appModel.principalText == context.principal, appModel.selectedDatabaseId == context.databaseId,
              requestIsValid, !starting, !publishing, !assistant.isGenerating, !assistant.isSynchronizingWorker else { return }
        startError = nil
        allowPendingStart = true
        starting = true
        Task { @MainActor in
            defer { starting = false }
            if conversation != nil {
                assistant.draft = request
                assistant.send()
            } else if !(await assistant.startWorkItemResearch(context: context, question: request,
                shouldStart: { allowPendingStart })) {
                startError = assistant.errorMessage ?? "Finish or clear the current Ask AI draft, then retry."
                return
            }
            guard assistant.isGenerating else { startError = "Research could not start. Check your database access and retry."; return }
            conversationID = assistant.currentConversation?.id
            request = ""
            initialRequest = ""
            publication = nil
        }
    }

    private func publish() async {
        guard !publishing, let answer = finishedAnswer, let conversation,
              let reference = conversation.workItemResearch,
              let question = conversation.messages.last(where: { $0.role == .user })?.text else { return }
        publishing = true
        defer { publishing = false }
        publication = await workItems.publishResearchResult(context: reference, question: question, answer: answer)
    }

    private func close() {
        appModel.setWorkItemDraftActive(false, owner: draftOwner)
        dismiss()
        if let sourceToOpen { assistant.openSource(sourceToOpen) }
    }

    private func leaveChangedContext() {
        if running { assistant.cancelGeneration() }
        dismiss()
    }
}
