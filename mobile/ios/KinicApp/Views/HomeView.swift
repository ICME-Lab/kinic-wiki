// Where: mobile/ios/KinicApp/Views/HomeView.swift
// What: Main native capture session surface.
// Why: Shared URLs are submitted automatically once sign-in and database selection are ready.

import SwiftUI

struct HomeView: View {
    @Bindable var model: AppModel
    @FocusState private var isManualURLFocused: Bool

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 16) {
                    SessionPanel(model: model)
                    DatabasePanel(model: model)
                    ManualURLPanel(model: model, isURLFocused: $isManualURLFocused)

                    if let message = model.statusMessage {
                        StatusPanel(message: message)
                    }
                }
                .padding(KinicDesign.screenPadding)
            }
            .scrollDismissesKeyboard(.interactively)
            .background {
                Color.white
                    .contentShape(Rectangle())
                    .onTapGesture {
                        isManualURLFocused = false
                    }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(.white, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbarColorScheme(.light, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    KinicHeaderTitle()
                }
                ToolbarItem(placement: .topBarTrailing) {
                    NavigationLink {
                        SettingsView(model: model)
                    } label: {
                        Image(systemName: "gearshape")
                            .font(.title3.weight(.semibold))
                            .foregroundStyle(KinicDesign.bodyGray)
                            .frame(width: 44, height: 44)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Settings")
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
