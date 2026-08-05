// Where: mobile/ios/KinicApp/Views/AskAIView.swift
// What: Ask AI tab root with database, history, and new-conversation controls.
// Why: DB scope and conversation boundaries must stay visible throughout grounded chat.

import SwiftUI

struct AskAIView: View {
    @Bindable var appModel: AppModel
    @Bindable var model: AskAIModel
    @State private var isShowingHistory = false

    var body: some View {
        AskAIWorkspaceView(model: model, appModel: appModel)
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    AskAIDatabaseMenu(model: model, appModel: appModel)
                }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button("History", systemImage: "clock.arrow.circlepath") {
                        isShowingHistory = true
                    }
                    .labelStyle(.iconOnly)

                    Button("New conversation", systemImage: "square.and.pencil", action: model.newConversation)
                        .labelStyle(.iconOnly)
                        .disabled(appModel.selectedAskAIDatabaseId.isEmpty)
                }
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
