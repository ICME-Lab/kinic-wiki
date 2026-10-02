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
        .sheet(isPresented: $model.isShowingDataConsent) {
            AskAIDataConsentView(agree: model.agreeToDataProcessingAndSend,
                cancel: { model.isShowingDataConsent = false })
        }
    }
}


struct AskAIDataConsentView: View {
    let agree: () -> Void
    let cancel: () -> Void

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("How Your Data Is Used").font(.title2.bold())
                    Text("Your question, the selected target, and up to six recent conversation messages (up to 4,000 characters) are sent to TypeSafe in the United States to determine whether you want a database overview, a selected-page summary, a focused search, or a conversation transformation. For focused searches, necessary Wiki paths and previews are also sent to TypeSafe for ranking.")
                    Text("Your question, conversation context, and relevant Wiki excerpts are sent to DeepSeek to generate the text answer. DeepSeek processes and stores data in China under its applicable terms. TypeSafe states that it does not train or fine-tune models on Input, but retains personal data as reasonably necessary rather than offering Zero Data Retention.")
                    Button("Agree and Send", action: agree)
                        .buttonStyle(.borderedProminent)
                    Button("Cancel", action: cancel)
                        .buttonStyle(.bordered)
                }
                .padding()
            }
            .navigationTitle("Ask AI Consent")
            .navigationBarTitleDisplayMode(.inline)
        }
        .interactiveDismissDisabled()
    }
}
