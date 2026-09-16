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
                        Text("質問、マイク音声と関連するWikiの内容をOpenAIに送信します。文字の会話はこの端末のAsk AI履歴に残ります。")
                        Text("料金はこのDBの残高から支払います。毎分 \(access.rate.cyclesPerMinute) cycles、1日上限 \(access.policy.budget) cycles。無音・ミュート中も接続時間に含まれます。")
                        Button("データの取り扱い") { showDetails = true }
                        Button("同意して開始") {
                            UserDefaults.standard.set(true, forKey: consentKey)
                            UserDefaults.standard.set(String(access.rate.version), forKey: rateKey)
                            needsConsent = false
                            launch()
                        }.buttonStyle(.borderedProminent)
                    }
                    ForEach(model.snapshot?.utterances ?? []) { utterance in
                        VStack(alignment: .leading) {
                            Text(utterance.role == "user" ? "あなた" : "Kinic").font(.caption).foregroundStyle(.secondary)
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
                        Button(model.historyError || model.endingRequested ? "終了処理を再試行" : "再試行") {
                            if model.endingRequested { close() }
                            else if model.historyError && model.snapshot == nil {
                                Task { await model.restore(databaseId: databaseID, principal: appModel.principalText); if !model.historyError { launch() } }
                            } else if model.historyError { close() } else { launch() }
                        }.disabled(preparing || model.busy || closing)
                        if model.failureCode == "microphone_denied" {
                            Link("iPhoneのマイク設定", destination: URL(string: UIApplication.openSettingsURLString)!)
                        } else { Button("音声設定") { showSettings = true } }
                    }
                    if model.snapshot != nil, !model.voiceActive, !preparing, !needsConsent, model.error == nil {
                        Button("音声を開始") { launch() }.buttonStyle(.borderedProminent)
                    }
                }.padding()
            }
            .navigationTitle("音声対話")
            .navigationBarTitleDisplayMode(.inline)
            .safeAreaInset(edge: .bottom) {
                HStack(spacing: 32) {
                    Button { model.toggleMute() } label: {
                        Label(model.muted ? "ミュート解除" : "ミュート", systemImage: model.muted ? "mic.slash.fill" : "mic.fill")
                    }.disabled(!model.voiceActive || closing).buttonStyle(.bordered)
                    Button(action: close) { Label("終了", systemImage: "xmark") }
                        .buttonStyle(.borderedProminent).disabled(closing)
                        .accessibilityIdentifier("voice.end")
                }.padding().frame(maxWidth: .infinity).background(.bar)
            }
            .interactiveDismissDisabled()
            .alert("履歴を保存しました", isPresented: $showFinalizationWarning) {
                Button("閉じる") { dismiss() }
            } message: { Text(model.finalizationWarning ?? "") }
            .sheet(isPresented: $showDetails) {
                NavigationStack {
                    ScrollView { Text("音声と質問、会話の文脈、関連するWikiの抜粋をOpenAIに送ります。Kinicは音声録音を保存しません。文字の会話と出典は端末に保存され、Ask AI履歴から削除できます。中断から復旧するためサーバーにも一時的に会話を保存します。終了処理後にKinicの一時会話を削除し、OpenAIのAgentセッションの削除を要求します。OpenAIのAgentセッションは米国で保存され、Zero Data Retentionには対応しません。提供元の記録やバックアップは各保持期間中残る場合があります。") .padding() }
                        .navigationTitle("データの取り扱い")
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
        if model.finishing || closing { return "終了しています…" }
        if model.reconnecting { return "再接続しています…" }
        if preparing || model.busy { return "接続しています…" }
        if model.snapshot?.status == "working" { return "Wikiを調べて回答しています…" }
        if model.voiceActive { return model.muted ? "マイクはミュート中です" : "話しかけてください" }
        return needsConsent ? "音声対話を始める" : "音声は停止しています"
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
