// Where: mobile/ios/KinicApp/Views/HomeView.swift
// What: Main native capture session surface.
// Why: Shared URLs are submitted automatically once sign-in and database selection are ready.

import SwiftUI

struct HomeView: View {
    @Bindable var model: AppModel
    @State private var selectedTab = HomeTab.home

    var body: some View {
        TabView(selection: $selectedTab) {
            NavigationStack {
                CaptureView(model: model)
            }
            .tabItem {
                Label("Home", systemImage: "house")
            }
            .tag(HomeTab.home)

            BrowseView(model: model, rootNavigationID: model.rootNavigationID)
            .tabItem {
                Label("Browse", systemImage: "folder")
            }
            .tag(HomeTab.browse)

            NavigationStack {
                ManageView(model: model)
            }
            .tabItem {
                Label("Manage", systemImage: "slider.horizontal.3")
            }
            .tag(HomeTab.manage)
        }
        .tint(KinicDesign.hotPink)
        .onChange(of: model.rootNavigationID) {
            selectedTab = .browse
        }
    }
}

private enum HomeTab: Hashable {
    case home
    case browse
    case manage
}

private struct CaptureView: View {
    @Bindable var model: AppModel
    @State private var isShowingIngest = false
    @State private var isShowingSettings = false

    var body: some View {
        ZStack {
            KinicDesign.appBackground
                .ignoresSafeArea()

            ScrollView {
                VStack(spacing: 16) {
                    SessionPanel(model: model)
                    DatabasePanel(model: model)

                    if let message = model.statusMessage {
                        StatusPanel(message: message)
                    }
                }
                .padding(KinicDesign.screenPadding)
            }
            .scrollDismissesKeyboard(.interactively)
            .background {
                KinicDesign.appBackground
                    .contentShape(Rectangle())
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(.visible, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .principal) {
                KinicHeaderTitle()
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button("Ingest", systemImage: "link.badge.plus") {
                    isShowingIngest = true
                }
                .labelStyle(.iconOnly)
                .tint(KinicDesign.hotPink)
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button("Settings", systemImage: "gearshape") {
                    isShowingSettings = true
                }
                .labelStyle(.iconOnly)
                .tint(KinicDesign.hotPink)
            }
        }
        .sheet(isPresented: $isShowingIngest) {
            IngestSheet(model: model)
        }
        .sheet(isPresented: $isShowingSettings) {
            NavigationStack {
                AppSettingsView(model: model)
            }
        }
        .task {
            model.refreshInbox()
            model.startRefreshDatabases()
            model.autoSubmitPendingURL()
        }
    }
}

private struct IngestSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Bindable var model: AppModel
    @FocusState private var isURLFocused: Bool

    var body: some View {
        NavigationStack {
            ZStack {
                KinicDesign.appBackground
                    .ignoresSafeArea()

                ScrollView {
                    ManualURLPanel(model: model, isURLFocused: $isURLFocused) {
                        dismiss()
                    }
                        .padding(KinicDesign.screenPadding)
                }
                .scrollDismissesKeyboard(.interactively)
                .background {
                    KinicDesign.appBackground
                        .contentShape(Rectangle())
                        .onTapGesture {
                            isURLFocused = false
                        }
                }
            }
            .navigationTitle("Ingest")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close", systemImage: "xmark") {
                        dismiss()
                    }
                    .labelStyle(.iconOnly)
                    .tint(KinicDesign.hotPink)
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

#Preview {
    HomeView(model: .preview())
}
