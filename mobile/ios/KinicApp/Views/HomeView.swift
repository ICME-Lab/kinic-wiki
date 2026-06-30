// Where: mobile/ios/KinicApp/Views/HomeView.swift
// What: Main capture inbox and session surface.
// Why: Shared URLs need a native place to review and submit.

import SwiftUI

struct HomeView: View {
    @Bindable var model: AppModel

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 16) {
                    KinicHeroView(pendingCount: model.pendingURLs.count, isSignedIn: model.isSignedIn)
                    SessionPanel(model: model)
                    DatabasePanel(model: model)
                    CapturePanel(model: model)

                    if let message = model.statusMessage {
                        StatusPanel(message: message)
                    }
                }
                .padding(KinicDesign.screenPadding)
            }
            .background(.white)
            .navigationTitle("KinicWiki")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    KinicHeaderTitle()
                }
                ToolbarItem(placement: .topBarTrailing) {
                    NavigationLink("Settings", destination: SettingsView(model: model))
                }
            }
            .task {
                model.refreshInbox()
                model.startRefreshDatabases()
                model.autoSubmitPendingURL()
            }
        }
    }
}

#Preview {
    HomeView(model: .preview())
}
