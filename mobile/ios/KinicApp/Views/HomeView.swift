// Where: mobile/ios/KinicApp/Views/HomeView.swift
// What: Main native capture session surface.
// Why: Shared URLs are submitted automatically once sign-in and database selection are ready.

import SwiftUI

struct HomeView: View {
    @Bindable var model: AppModel
    @State private var selectedTab = HomeTab.capture

    var body: some View {
        TabView(selection: $selectedTab) {
            NavigationStack {
                CaptureView(model: model)
            }
            .tabItem {
                Label("Capture", systemImage: "square.and.arrow.down")
            }
            .tag(HomeTab.capture)

            BrowseView(model: model, rootNavigationID: model.rootNavigationID)
            .tabItem {
                Label("Browse", systemImage: "folder")
            }
            .tag(HomeTab.browse)

            NavigationStack {
                SettingsView(model: model)
            }
            .tabItem {
                Label("Settings", systemImage: "gearshape")
            }
            .tag(HomeTab.settings)
        }
        .tint(KinicDesign.hotPink)
        .onChange(of: model.rootNavigationID) {
            selectedTab = .browse
        }
    }
}

private enum HomeTab: Hashable {
    case capture
    case browse
    case settings
}

private struct CaptureView: View {
    @Bindable var model: AppModel
    @FocusState private var isManualURLFocused: Bool

    var body: some View {
        ZStack {
            Color.white
                .ignoresSafeArea()

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
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(.white, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .toolbarColorScheme(.light, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .principal) {
                KinicHeaderTitle()
            }
        }
        .task {
            model.refreshInbox()
            model.startRefreshDatabases()
            model.autoSubmitPendingURL()
        }
    }
}

#Preview {
    HomeView(model: .preview())
}
