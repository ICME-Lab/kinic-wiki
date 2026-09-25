// Where: mobile/ios/KinicApp/Views/HomeView.swift
// What: Main tab shell. Home lists shared work items for the selected database.
// Why: Captures must be shared state, not a device-local queue that looks submitted.

import SwiftUI

struct HomeView: View {
    @Environment(\.scenePhase) private var scenePhase
    @Bindable var model: AppModel
    @State private var askAIModel: AskAIModel
    @State private var workItemModel: WorkItemModel
    @State private var selectedTab = AppTab.home
    @State private var homePath = NavigationPath()
    @State private var homeDatabaseId: String
    @State private var isShowingSettings = false

    init(model: AppModel, workItemModel: WorkItemModel? = nil) {
        self.model = model
        _askAIModel = State(initialValue: AskAIModel(appModel: model))
        _workItemModel = State(initialValue: workItemModel ?? WorkItemModel(appModel: model))
        _homeDatabaseId = State(initialValue: model.selectedDatabaseId)
    }

    var body: some View {
        TabView(selection: $selectedTab) {
            NavigationStack(path: $homePath) {
                WorkItemListView(
                    appModel: model,
                    model: workItemModel,
                    askAIModel: askAIModel,
                    openSearchResult: { homePath.append($0) }
                )
            }
            .tabItem {
                Label("Home", systemImage: "house")
            }
            .tag(AppTab.home)

            BrowseView(model: model, rootNavigationID: model.rootNavigationID)
            .tabItem {
                Label("Browse", systemImage: "folder")
            }
            .tag(AppTab.browse)

            NavigationStack {
                AskAIView(appModel: model, model: askAIModel)
            }
            .tabItem {
                Label("Ask AI", systemImage: "sparkles")
            }
            .tag(AppTab.askAI)

            NavigationStack {
                ManageView(model: model)
            }
            .tabItem {
                Label("Manage", systemImage: "slider.horizontal.3")
            }
            .tag(AppTab.manage)
        }
        .environment(\.openKinicSettings, { isShowingSettings = true })
        .sheet(isPresented: $isShowingSettings) {
            NavigationStack { AppSettingsView(model: model, askAIModel: askAIModel) }
        }
        .task { model.startRefreshDatabases() }
        .onChange(of: model.principalText) {
            homePath = NavigationPath()
            workItemModel.resetContext()
            homeDatabaseId = model.selectedDatabaseId
            if model.isSignedIn { model.voicePreview.contextChanged(databaseId: model.selectedAskAIDatabaseId, principal: model.principalText) }
            else { model.voicePreview.end() }
        }
        .onChange(of: model.selectedAskAIDatabaseId) {
            if model.isSignedIn { model.voicePreview.contextChanged(databaseId: model.selectedAskAIDatabaseId, principal: model.principalText) }
        }
        .onChange(of: model.voiceSettingsHasChanges) { _, blocked in
            if !blocked { model.restoreSharedDatabaseSelection() }
        }
        .onChange(of: model.databaseSelectionLocked) { _, locked in
            if !locked { model.restoreSharedDatabaseSelection() }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                model.restoreSharedDatabaseSelection()
                // Items the Share Extension queued wait here until the app can store and send them.
                Task { await workItemModel.importQueuedCaptures() }
            }
            // Permission prompts make the scene inactive without backgrounding it.
            // Keep the control connection while the user grants microphone access.
            if phase != .inactive { model.voicePreview.sceneChanged(active: phase == .active) }
        }
        .tint(KinicDesign.hotPink)
        .onChange(of: model.rootNavigationID) {
            selectedTab = .browse
        }
        .onChange(of: model.tabSelectionRequestID) {
            selectedTab = model.requestedTab
            reconcileHomeNavigation()
        }
        .onChange(of: model.workItemNavigationRequestID) {
            selectedTab = .home
            reconcileHomeNavigation()
        }
        .onChange(of: model.workItemComposeRequestID) {
            // The composer itself is presented by WorkItemListView, which owns the sheet.
            selectedTab = .home
        }
        .onChange(of: model.selectedDatabaseId) {
            reconcileHomeNavigation()
        }
    }

    private func reconcileHomeNavigation() {
        if homeDatabaseId != model.selectedDatabaseId {
            homePath = NavigationPath()
            workItemModel.resetContext()
            homeDatabaseId = model.selectedDatabaseId
        }
        pushRequestedWorkItem()
    }

    /// Pushes a work item opened from another surface once Home targets its database.
    private func pushRequestedWorkItem() {
        // Consuming the request immediately is what prevents a duplicate push on the next change.
        guard let request = model.requestedWorkItemDetail,
              request.databaseId == model.selectedDatabaseId else {
            return
        }
        model.consumeWorkItemDetailRequest(request)
        homePath.append(request.itemId)
    }
}

struct IngestSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Bindable var model: AppModel
    @FocusState private var isURLFocused: Bool
    @State private var hasInput = false
    @State private var confirmsDiscard = false

    var body: some View {
        NavigationStack {
            ZStack {
                KinicDesign.appBackground
                    .ignoresSafeArea()

                ScrollView {
                    ManualURLPanel(model: model, isURLFocused: $isURLFocused, onSubmitted: {
                        dismiss()
                    }, onInputChanged: { hasInput = $0 })
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
            .navigationTitle("Save URL")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close", systemImage: "xmark") {
                        if hasInput { confirmsDiscard = true } else { dismiss() }
                    }
                    .labelStyle(.iconOnly)
                    .tint(KinicDesign.hotPink)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .interactiveDismissDisabled(hasInput || model.isSubmitting)
        .alert("Discard this URL?", isPresented: $confirmsDiscard) {
            Button("Discard", role: .destructive) { dismiss() }
            Button("Keep editing", role: .cancel) {}
        }
    }
}

#Preview {
    HomeView(model: .preview())
}
