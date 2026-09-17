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

            if appModel.selectedDatabaseId.isEmpty && appModel.isLoadingDatabases {
                ProgressView("データベースを読み込み中")
            } else if appModel.selectedDatabaseId.isEmpty, let error = appModel.databaseListError {
                ContentUnavailableView {
                    Label("データベースを読み込めません", systemImage: "wifi.exclamationmark")
                } description: { Text(error) } actions: {
                    Button("再試行", action: appModel.startRefreshDatabases)
                }
            } else {
                AskAIConversationView(model: model)
            }
        }
        .safeAreaInset(edge: .bottom) {
            AskAIComposerView(model: model)
        }
    }
}
