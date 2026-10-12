// Where: mobile/ios/KinicApp/Views/AskAIWorkspaceView.swift
// What: Responsive Ask AI conversation workspace with inline sources.
// Why: Direct chat and compact citations should use the same focused layout at every size.

import SwiftUI

struct AskAIWorkspaceView: View {
    @Bindable var model: AskAIModel
    @Bindable var appModel: AppModel

    var body: some View {
        ZStack {
            KinicDesign.appBackground
                .ignoresSafeArea()

            if model.messages.isEmpty {
                // A quiet aurora wash at the top invites the first question; it fades once chatting starts.
                KinicAurora(intensity: 0.55)
                    .mask(LinearGradient(colors: [.black, .clear], startPoint: .top, endPoint: .center))
                    .ignoresSafeArea()
                    .transition(.opacity)
            }

            if appModel.selectedDatabaseId.isEmpty && appModel.isLoadingDatabases {
                ProgressView("Loading databases…")
            } else if appModel.selectedDatabaseId.isEmpty, let error = appModel.databaseListError {
                ContentUnavailableView {
                    Label("Could not load databases", systemImage: "wifi.exclamationmark")
                } description: { Text(error) } actions: {
                    Button("Retry", action: appModel.startRefreshDatabases)
                }
            } else {
                AskAIConversationView(model: model, createWorkItem: { message in
                    appModel.requestWorkItemDraft(
                        databaseId: appModel.selectedAskAIDatabaseId,
                        title: nil,
                        body: message.text,
                        source: appModel.workItemSource(forAskAIMessage: message)
                    )
                })
            }
        }
        .safeAreaInset(edge: .bottom) {
            AskAIComposerView(model: model)
        }
    }
}
