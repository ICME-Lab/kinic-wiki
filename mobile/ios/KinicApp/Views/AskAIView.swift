// Where: mobile/ios/KinicApp/Views/AskAIView.swift
// What: Ask AI tab root with database, history, and new-conversation controls.
// Why: DB scope and conversation boundaries must stay visible throughout grounded chat.

import SwiftUI

struct AskAIView: View {
    @Bindable var appModel: AppModel
    @Bindable var model: AskAIModel
    @State private var isShowingPreview = false
    @State private var isShowingHistory = false

    var body: some View {
        AskAIWorkspaceView(model: model, appModel: appModel)
            .navigationTitle("")
            .onChange(of: isShowingPreview) { _, showing in appModel.voicePresentationActive = showing }
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    DatabaseContextBar(model: appModel, askAIModel: model, compact: true)
                }
                .databaseTitleAppearance()
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button("Voice Conversation", systemImage: "waveform") { appModel.voicePresentationActive = true; isShowingPreview = true }
                            .disabled(model.isGenerating || model.loadState != .loaded || appModel.selectedAskAIDatabaseId.isEmpty)
                        Button("Conversation history", systemImage: "clock.arrow.circlepath") {
                            isShowingHistory = true
                        }

                        Button("New conversation", systemImage: "square.and.pencil", action: model.newConversation)
                            .disabled(appModel.selectedAskAIDatabaseId.isEmpty)
                    } label: {
                        Label("Conversation actions", systemImage: "ellipsis")
                    }
                }
            }
            .fullScreenCover(isPresented: $isShowingPreview) {
                VoicePreviewView(appModel: appModel, model: appModel.voicePreview, historyModel: model)
            }
            .sheet(isPresented: $isShowingHistory) {
                AskAIHistoryView(model: model)
            }
            .confirmationDialog(
                "Start a new conversation?",
                isPresented: $model.isConfirmingDatabaseChange,
                titleVisibility: .visible
            ) {
                Button("Start with \(model.pendingDatabaseTitle ?? "database")", action: model.confirmDatabaseChange)
                Button("Cancel", role: .cancel, action: model.cancelDatabaseChange)
            } message: {
                Text("A conversation can use one database only.")
            }
            .confirmationDialog(
                "Reset local history?",
                isPresented: $model.isConfirmingHistoryReset,
                titleVisibility: .visible
            ) {
                Button("Reset local history", role: .destructive, action: resetHistory)
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("The unreadable history will be archived on this device before a new empty history is created.")
            }
            .task(id: appModel.askAIHistoryScope) {
                let historyScope = appModel.askAIHistoryScope
                model.changeHistoryScope(
                    to: historyScope,
                    store: AskAIConversationStore.live(scope: historyScope)
                )
                appModel.startRefreshDatabases()
                await model.load()
            }
            .onChange(of: appModel.askAIHistoryScope) {
                let historyScope = appModel.askAIHistoryScope
                isShowingHistory = false
                model.changeHistoryScope(
                    to: historyScope,
                    store: AskAIConversationStore.live(scope: historyScope)
                )
            }
            .onChange(of: appModel.selectedBrowseDatabaseId) {
                model.syncSelectedDatabase()
            }
            .onChange(of: appModel.browseDatabaseSelectionResolution) { _, resolution in
                if let resolution {
                    model.resolveBrowseDatabaseSelection(resolution)
                }
            }
    }

    private func resetHistory() {
        Task {
            await model.resetHistoryAfterLoadFailure()
        }
    }
}

#Preview {
    let appModel = AppModel.preview()
    NavigationStack {
        AskAIView(appModel: appModel, model: AskAIModel(appModel: appModel))
    }
}
