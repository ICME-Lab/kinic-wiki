import SwiftUI

struct VoicePreviewView: View {
    @Bindable var appModel: AppModel
    @Bindable var model: VoicePreviewModel
    var historyModel: AskAIModel? = nil
    @Environment(\.dismiss) private var dismiss
    @State private var startup: Task<Void, Never>?
    @State private var preparing = false
    @State private var closing = false
    @State private var showFinalizationWarning = false
    @State private var needsConsent = false
    @State private var access: VoiceAccessInfo?
    @State private var showDetails = false
    @State private var showSettings = false
    @State private var conversationID = UUID()
    @State private var databaseID = ""
    @State private var databaseTitle = ""
    private let consentVersion = "2026-09-16"
    private var consentKey: String { "voice.consent.\(appModel.principalText).\(consentVersion)" }
    private var rateKey: String { "voice.rate.\(appModel.principalText).\(databaseID)" }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    Text(databaseTitle).font(.headline)
                    Label(status, systemImage: model.voiceActive ? "waveform" : "mic")
                        .font(.title2).accessibilityIdentifier("voice.status")
                    if preparing || model.busy || model.finishing { ProgressView() }
                    if needsConsent, let access {
                        Text("Your questions, microphone audio, and relevant Wiki content will be sent to OpenAI. The text conversation will remain in Ask AI history on this device.")
                        Text("Charges are paid from this database's balance. The rate is \(DatabaseManagementFormat.cycles(access.rate.cyclesPerMinute)) per minute, with a daily limit of \(DatabaseManagementFormat.cycles(access.policy.budget)). Silence and muted time still count as connected time.")
                        Button("How Your Data Is Used") { showDetails = true }
                        Button("Agree and Start") {
                            UserDefaults.standard.set(true, forKey: consentKey)
                            UserDefaults.standard.set(String(access.rate.version), forKey: rateKey)
                            needsConsent = false
                            launch()
                        }.buttonStyle(.borderedProminent)
                    }
                    ForEach(model.snapshot?.utterances ?? []) { utterance in
                        VStack(alignment: .leading) {
                            Text(utterance.role == "user" ? "You" : "Kinic").font(.caption).foregroundStyle(.secondary)
                            Text(utterance.text).textSelection(.enabled)
                        }
                    }
                    ForEach(model.snapshot?.messages ?? []) { message in
                        VStack(alignment: .leading, spacing: 8) {
                            if !message.voice { Text(message.question).font(.headline) }
                            if let answer = message.answer {
                                Text(answer.displayText).textSelection(.enabled)
                                ForEach(answer.citations) { citation in
                                    Text(citation.path).font(.caption).foregroundStyle(.secondary)
                                    Text(citation.excerpt).font(.caption)
                                }
                            }
                        }
                    }
                    if let error = model.error {
                        Text(error).foregroundStyle(.red).accessibilityIdentifier("voice.error")
                        Button(model.historyError || model.endingRequested ? "Retry Ending" : "Retry") {
                            if model.endingRequested { close() }
                            else if model.historyError && model.snapshot == nil {
                                Task { await model.restore(databaseId: databaseID, principal: appModel.principalText); if !model.historyError { launch() } }
                            } else if model.historyError { close() } else { launch() }
                        }.disabled(preparing || model.busy || closing)
                        if model.failureCode == "microphone_denied" {
                            Link("iPhone Microphone Settings", destination: URL(string: UIApplication.openSettingsURLString)!)
                        } else { Button("Voice Settings") { showSettings = true } }
                    }
                    if model.snapshot != nil, !model.voiceActive, !preparing, !needsConsent, model.error == nil {
                        Button("Start Voice") { launch() }.buttonStyle(.borderedProminent)
                    }
                }.padding()
            }
            .navigationTitle("Voice Conversation")
            .navigationBarTitleDisplayMode(.inline)
            .safeAreaInset(edge: .bottom) {
                HStack(spacing: 32) {
                    Button { model.toggleMute() } label: {
                        Label(model.muted ? "Unmute" : "Mute", systemImage: model.muted ? "mic.slash.fill" : "mic.fill")
                    }.disabled(!model.voiceActive || closing).buttonStyle(.bordered)
                    Button(action: close) { Label("End", systemImage: "xmark") }
                        .buttonStyle(.borderedProminent).disabled(closing)
                        .accessibilityIdentifier("voice.end")
                }.padding().frame(maxWidth: .infinity).background(.bar)
            }
            .interactiveDismissDisabled()
            .alert("History Saved", isPresented: $showFinalizationWarning) {
                Button("Close") { dismiss() }
            } message: { Text(model.finalizationWarning ?? "") }
            .sheet(isPresented: $showDetails) {
                NavigationStack {
                    ScrollView { Text("Voice audio, questions, conversation context, and relevant Wiki excerpts are sent to OpenAI. Kinic does not save audio recordings. Text conversations and citations are stored on this device and can be deleted from Ask AI history. The conversation is also stored temporarily on the server so it can recover from interruptions. After ending, Kinic deletes its temporary conversation and requests deletion of the OpenAI Agent session. OpenAI Agent sessions are stored in the United States and do not support Zero Data Retention. Provider logs or backups may remain for their applicable retention periods.") .padding() }
                        .navigationTitle("How Your Data Is Used")
                }
            }
            .sheet(isPresented: $showSettings) { NavigationStack { VoiceSettingsView(appModel: appModel) } }
            .task {
#if DEBUG
                if ProcessInfo.processInfo.environment["KINIC_SCREENSHOT_MODE"] == "voice-preview" {
                    databaseID = "demo"; databaseTitle = "Personal Memory"
                    model.loadScreenshotFixture()
                    return
                }
#endif
                databaseID = appModel.selectedAskAIDatabaseId
                databaseTitle = appModel.selectedAskAIDatabaseTitle
                let scope = appModel.askAIHistoryScope
                if let current = historyModel?.currentConversation, current.databaseId == databaseID { conversationID = current.id }
                model.historyConversationID = conversationID
                model.historyDatabaseTitle = databaseTitle
                model.saveHistory = { snapshot, historyID, historyTitle in
                    guard let historyModel else { throw URLError(.cannotWriteToFile) }
                    try await historyModel.saveVoiceSnapshot(snapshot, conversationID: historyID, title: historyTitle, scope: scope)
                }
                await model.restore(databaseId: databaseID, principal: appModel.principalText)
                if model.snapshot == nil {
                    model.historyConversationID = historyModel?.currentConversation.flatMap { $0.databaseId == databaseID ? $0.id : nil } ?? conversationID
                    model.historyDatabaseTitle = databaseTitle
                }
                if !model.historyError { launch() }
            }
            .onChange(of: appModel.principalText) { startup?.cancel(); model.end(); dismiss() }
            .onDisappear { startup?.cancel(); model.stopVoice() }
        }
    }
    private var status: String {
        if model.finishing || closing { return "Ending…" }
        if model.reconnecting { return "Reconnecting…" }
        if preparing || model.busy { return "Connecting…" }
        if model.snapshot?.status == "working" { return "Searching the Wiki and preparing an answer…" }
        if model.voiceActive { return model.muted ? "Microphone muted" : "Start speaking" }
        return needsConsent ? "Start a voice conversation" : "Voice stopped"
    }
    private func launch() {
        guard !preparing, !closing, !model.voiceActive, !model.endingRequested else { return }
        preparing = true
        model.clearError()
        startup = Task {
            defer { preparing = false }
            do {
                guard appModel.isSignedIn, !databaseID.isEmpty else { throw AssistantHTTPError(status: 401, code: "kinic_session_expired") }
                let owner = appModel.askAIDatabaseCandidates.first { $0.databaseId == databaseID }?.role == .owner
                let info = try await appModel.voiceAccess(databaseId: databaseID, principal: appModel.principalText, initializeOwner: owner)
                try Task.checkCancellation()
                access = info
                guard info.policy.enabled else { throw AssistantHTTPError(status: 403, code: "voice_permission_required") }
                guard info.remainingCycles >= info.rate.cyclesPerMinute else { throw AssistantHTTPError(status: 403, code: "voice_budget_exhausted") }
                guard info.balanceCycles >= info.rate.cyclesPerMinute else { throw AssistantHTTPError(status: 403, code: "voice_balance_insufficient") }
                guard UserDefaults.standard.bool(forKey: consentKey), UserDefaults.standard.string(forKey: rateKey) == String(info.rate.version) else { needsConsent = true; return }
                if model.snapshot == nil {
                    model.scope = UserDefaults.standard.string(forKey: "voice.scope.\(appModel.principalText)") ?? "/Knowledge"
                    let history = AssistantHistoryContext.make(historyModel?.currentConversation.flatMap { $0.databaseId == databaseID ? $0.messages : nil } ?? [])
                    await appModel.connectVoicePreview(databaseId: databaseID, selectedPath: appModel.selectedBrowseNodePath, history: history)
                }
                try Task.checkCancellation()
                guard model.snapshot != nil else { return }
                try await model.waitForControl()
                await model.loadQuote()
                try Task.checkCancellation()
                guard let quote = model.quote else { return }
                guard quote.rateVersion == String(info.rate.version) else {
                    UserDefaults.standard.removeObject(forKey: rateKey)
                    throw AssistantHTTPError(status: 400, code: "voice_price_consent_required")
                }
                await model.startVoice(quote: quote)
            } catch is CancellationError {} catch { model.report(error) }
        }
    }
    private func close() {
        guard !closing else { return }
        closing = true
        startup?.cancel()
        // Invalidates a connection still waiting for authentication.
        if model.snapshot == nil { model.end(); dismiss(); return }
        Task {
            if await model.finish() {
                if model.finalizationWarning != nil { showFinalizationWarning = true }
                else { dismiss() }
            }
            closing = false
        }
    }
}
