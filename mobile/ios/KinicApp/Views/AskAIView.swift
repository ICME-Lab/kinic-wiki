// Where: mobile/ios/KinicApp/Views/AskAIView.swift
// What: Ask AI tab root with database, history, and new-conversation controls.
// Why: DB scope and conversation boundaries must stay visible throughout grounded chat.

import SwiftUI

struct AskAIView: View {
    @Bindable var appModel: AppModel
    @State private var model: AskAIModel
    @State private var isShowingHistory = false

    init(appModel: AppModel) {
        self.appModel = appModel
        _model = State(initialValue: AskAIModel(appModel: appModel))
    }

    var body: some View {
        AskAIWorkspaceView(model: model, appModel: appModel)
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    AskAIDatabaseMenu(model: model, appModel: appModel)
                }
                ToolbarItem(placement: .topBarLeading) {
                    Text(
                        appModel.selectedAskAIDatabaseTitle.isEmpty
                            ? "Choose database"
                            : appModel.selectedAskAIDatabaseTitle
                    )
                    .font(.headline)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .accessibilityHidden(true)
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
                Text("A conversation uses evidence from one database only.")
            }
            .task {
                appModel.startRefreshDatabases()
                await model.load()
            }
            .onChange(of: appModel.selectedBrowseDatabaseId) {
                model.syncSelectedDatabase()
            }
    }
}

#Preview {
    NavigationStack {
        AskAIView(appModel: .preview())
    }
}
