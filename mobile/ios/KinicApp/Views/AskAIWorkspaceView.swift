// Where: mobile/ios/KinicApp/Views/AskAIWorkspaceView.swift
// What: Responsive Ask AI conversation and evidence workspace.
// Why: iPhone keeps evidence inline while iPad gives verified sources a persistent rail.

import SwiftUI

struct AskAIWorkspaceView: View {
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Bindable var model: AskAIModel
    @Bindable var appModel: AppModel

    var body: some View {
        ZStack {
            KinicDesign.appBackground
                .ignoresSafeArea()

            if appModel.selectedAskAIDatabaseId.isEmpty {
                ContentUnavailableView {
                    Label("Choose a database", systemImage: "externaldrive.badge.questionmark")
                } description: {
                    Text("Ask AI searches one readable database at a time.")
                }
            } else if !appModel.canAskAI {
                ContentUnavailableView {
                    Label("Database unavailable", systemImage: "lock")
                } description: {
                    Text("Sign in or choose a public database before asking a question.")
                }
            } else if horizontalSizeClass == .regular {
                HStack(spacing: 0) {
                    AskAIConversationView(model: model)
                    Divider()
                    AskAIEvidencePanel(model: model)
                        .frame(width: 320)
                }
            } else {
                AskAIConversationView(model: model)
            }
        }
        .safeAreaInset(edge: .bottom) {
            if appModel.canAskAI, !appModel.selectedAskAIDatabaseId.isEmpty {
                AskAIComposerView(model: model)
            }
        }
    }
}
