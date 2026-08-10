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

            AskAIConversationView(model: model)
        }
        .safeAreaInset(edge: .bottom) {
            AskAIComposerView(model: model)
        }
    }
}
