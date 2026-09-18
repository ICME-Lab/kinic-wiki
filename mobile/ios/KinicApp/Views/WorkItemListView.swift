// Where: mobile/ios/KinicApp/Views/WorkItemListView.swift
// What: Home surface listing DB-scoped work items and unsent local captures.
// Why: A capture saved on this device must never be presented as shared with the database.

import SwiftUI

enum WorkItemFilter: String, CaseIterable, Identifiable {
    case open
    case closed
    case all

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .open: "Open"
        case .closed: "Closed"
        case .all: "All"
        }
    }

    func matches(_ entry: WorkItemListEntry) -> Bool {
        switch self {
        case .open: entry.state == .open
        case .closed: entry.state == .closed
        case .all: true
        }
    }
}

struct WorkItemListView: View {
    @Bindable var appModel: AppModel
    @Bindable var model: WorkItemModel
    let askAIModel: AskAIModel

    @State private var filter: WorkItemFilter = .open
    @State private var isShowingComposer = false
    /// Prefill handed over by Browse, Ask AI, or a widget link.
    @State private var composerDraft: WorkItemComposeRequest?
    @State private var isShowingIngest = false
    @State private var isShowingHistory = false
    @State private var isShowingSettings = false
    @State private var isShowingDatabase = false

    private var visibleEntries: [WorkItemListEntry] {
        model.entries.filter(filter.matches)
    }

    var body: some View {
        Group {
            if !appModel.isSignedIn {
                setupSurface
            } else if appModel.selectedDatabase == nil {
                setupSurface
            } else {
                listSurface
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(.visible, for: .navigationBar)
        .toolbar { toolbarContent }
        .task {
            appModel.refreshInbox()
            appModel.startRefreshDatabases()
            appModel.startRefreshSourceCaptureHistory()
            appModel.autoSubmitPendingURL()
            presentRequestedCompose()
            await model.importQueuedCaptures()
            await model.refresh()
        }
        .onChange(of: appModel.selectedDatabaseId) {
            presentRequestedCompose()
            Task { await model.refresh() }
        }
        .onChange(of: appModel.workItemComposeRequestID) {
            presentRequestedCompose()
        }
        .task(id: model.searchQuery) {
            let trimmed = model.searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else {
                // Clearing the field must restore the list, not leave the last results on screen.
                model.clearSearchResults()
                return
            }
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            await model.search(model.searchQuery)
        }
        .sheet(isPresented: $isShowingComposer) {
            WorkItemComposerView(appModel: appModel, model: model, draft: composerDraft)
        }
        .sheet(isPresented: $isShowingIngest) {
            IngestSheet(model: appModel)
        }
        .sheet(isPresented: $isShowingHistory) {
            NavigationStack {
                ScrollView {
                    SourceCaptureHistoryPanel(model: appModel)
                        .padding(KinicDesign.screenPadding)
                }
                .navigationTitle("Capture history")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Close", systemImage: "xmark") { isShowingHistory = false }
                            .labelStyle(.iconOnly)
                            .tint(KinicDesign.hotPink)
                    }
                }
            }
        }
        .sheet(isPresented: $isShowingSettings) {
            NavigationStack {
                AppSettingsView(model: appModel, askAIModel: askAIModel)
            }
        }
        .sheet(isPresented: $isShowingDatabase) {
            NavigationStack {
                ScrollView {
                    VStack(spacing: 16) {
                        SessionPanel(model: appModel)
                        DatabasePanel(model: appModel)
                    }
                    .padding(KinicDesign.screenPadding)
                }
                .navigationTitle("Database")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Close", systemImage: "xmark") { isShowingDatabase = false }
                            .labelStyle(.iconOnly)
                            .tint(KinicDesign.hotPink)
                    }
                }
            }
        }
    }

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        if #available(iOS 26.0, *) {
            ToolbarItem(placement: .topBarLeading) {
                KinicHeaderTitle()
            }
            .sharedBackgroundVisibility(.hidden)
        } else {
            ToolbarItem(placement: .topBarLeading) {
                KinicHeaderTitle()
            }
        }
        if appModel.selectedDatabase != nil {
            ToolbarItem(placement: .topBarTrailing) {
                Button("New item", systemImage: "square.and.pencil") {
                    composerDraft = nil
                    isShowingComposer = true
                }
                .labelStyle(.iconOnly)
                .tint(KinicDesign.hotPink)
                .disabled(!model.canWrite)
                .accessibilityHint(model.canWrite ? "" : "You have read-only access to this database")
            }
        }
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                Button("Database", systemImage: "externaldrive") { isShowingDatabase = true }
                Button("Ingest URL", systemImage: "link.badge.plus") { isShowingIngest = true }
                Button("Capture history", systemImage: "clock.arrow.circlepath") { isShowingHistory = true }
                Button("Settings", systemImage: "gearshape") { isShowingSettings = true }
            } label: {
                Label("More", systemImage: "ellipsis.circle")
            }
            .tint(KinicDesign.hotPink)
        }
    }

    private var setupSurface: some View {
        ScrollView {
            VStack(spacing: 16) {
                SessionPanel(model: appModel)
                DatabasePanel(model: appModel)
                if let message = appModel.statusMessage {
                    StatusPanel(message: message)
                }
            }
            .padding(KinicDesign.screenPadding)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(KinicDesign.appBackground)
    }

    private var listSurface: some View {
        List {
            if let message = model.actionError {
                Section {
                    StatusPanel(message: message)
                        .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                }
            }

            if model.isSearching {
                searchSection
            } else {
                if !model.localCaptures.isEmpty {
                    Section {
                        ForEach(model.localCaptures) { capture in
                            LocalCaptureRow(capture: capture) {
                                Task { await model.retryLocalCapture(capture.captureId) }
                            } onDiscard: {
                                model.discardLocalCapture(capture.captureId)
                            }
                        }
                    } header: {
                        Text("On this device")
                    } footer: {
                        Text("Saved on this device only. They appear in the database after they are sent.")
                    }
                }

                if !model.pendingMutations.isEmpty {
                    pendingSection
                }

                itemsSection
            }
        }
        .listStyle(.insetGrouped)
        .searchable(
            text: $model.searchQuery,
            placement: .navigationBarDrawer(displayMode: .always),
            prompt: "Search items"
        )
        .refreshable { await model.refresh(force: true) }
        .navigationDestination(for: String.self) { itemId in
            WorkItemDetailView(model: model, appModel: appModel, itemId: itemId)
        }
        .overlay {
            if model.phase == .loading && model.entries.isEmpty && !model.isSearching {
                ProgressView()
            }
        }
    }

    private var itemsSection: some View {
        Section {
            if visibleEntries.isEmpty {
                Text(emptyListMessage)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(visibleEntries) { entry in
                    NavigationLink(value: entry.id) {
                        WorkItemRow(entry: entry)
                    }
                }
            }
        } header: {
            Picker("Filter", selection: $filter) {
                ForEach(WorkItemFilter.allCases) { option in
                    Text(option.displayName).tag(option)
                }
            }
            .pickerStyle(.segmented)
            .textCase(nil)
            .padding(.vertical, 4)
        } footer: {
            listFooter
        }
    }

    @ViewBuilder
    private var searchSection: some View {
        Section {
            switch model.searchPhase {
            case .searching:
                HStack(spacing: 8) {
                    ProgressView()
                    Text("Searching…")
                        .foregroundStyle(.secondary)
                }
            case .empty:
                Text("No items match “\(model.searchQuery)”.")
                    .foregroundStyle(.secondary)
            case .failed(let message):
                Text(message)
                    .foregroundStyle(.secondary)
            case .idle, .results:
                EmptyView()
            }

            ForEach(model.searchSnapshot.results) { result in
                NavigationLink(value: result.id) {
                    WorkItemSearchRow(result: result)
                }
            }
        } header: {
            Text("Results")
        } footer: {
            if model.searchSnapshot.isCapped {
                Text("Showing the first \(model.searchSnapshot.hitCount) matches. Narrow the search to find older items.")
            }
        }
    }

    @ViewBuilder
    private var pendingSection: some View {
        Section {
            ForEach(model.pendingMutations) { mutation in
                HStack(spacing: 12) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(mutation.kind.displayName)
                            .font(.subheadline.weight(.semibold))
                        Text(mutation.itemId)
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    Spacer()
                    Button("Send") {
                        Task { await model.retryPendingMutation(mutation) }
                    }
                    Button("Discard", role: .destructive) {
                        model.discardPendingMutation(mutation.mutationId)
                    }
                }
                .buttonStyle(.borderless)
                .tint(KinicDesign.hotPink)
            }
        } header: {
            Text("Unsent changes")
        } footer: {
            Text("Saved on this device only. They are not in the database yet.")
        }
    }

    private var emptyListMessage: String {
        switch model.phase {
        case .loading: "Loading work items…"
        case .failed(let message): message
        default: "Nothing here yet. Create the first item."
        }
    }

    @ViewBuilder
    private var listFooter: some View {
        VStack(alignment: .leading, spacing: 4) {
            if !model.canWrite {
                Text("Read-only access to this database.")
            }
            if let lastFetchedAt = model.lastFetchedAt {
                Text("Updated \(Self.date(fromMilliseconds: lastFetchedAt).formatted(.relative(presentation: .named)))")
            }
            if model.isTruncated {
                Text("Showing 100 of \(model.totalCount) items.")
            }
            if model.unreadableCount > 0 {
                Text("\(model.unreadableCount) item(s) could not be read.")
            }
        }
    }

    /// Presents the composer once Home targets the database the request named.
    private func presentRequestedCompose() {
        guard let request = appModel.requestedWorkItemCompose,
              request.databaseId == appModel.selectedDatabaseId else {
            return
        }
        appModel.consumeWorkItemComposeRequest(request)
        composerDraft = request
        isShowingComposer = true
    }

    static func date(fromMilliseconds value: Int64) -> Date {
        Date(timeIntervalSince1970: Double(value) / 1000)
    }
}

private struct WorkItemRow: View {
    let entry: WorkItemListEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(entry.isUnsupportedVersion ? "Unsupported item version" : entry.title)
                .font(.headline)
                .foregroundStyle(entry.isUnsupportedVersion ? KinicDesign.bodyGray : Color.primary)
                .lineLimit(2)

            HStack(spacing: 10) {
                Label(entry.state.displayName, systemImage: entry.state == .open ? "circle" : "checkmark.circle.fill")
                Label("\(entry.commentCount)", systemImage: "bubble.left")
                Text(WorkItemListView.date(fromMilliseconds: entry.updatedAt).formatted(.relative(presentation: .named)))
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

private struct LocalCaptureRow: View {
    let capture: WorkItemCaptureRecord
    let onRetry: () -> Void
    let onDiscard: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(capture.provisionalTitle.isEmpty ? capture.rawText : capture.provisionalTitle)
                .font(.headline)
                .lineLimit(2)

            HStack(spacing: 10) {
                Label(capture.state.displayName, systemImage: "iphone")
                if capture.databaseId == nil {
                    Text("No database chosen")
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)

            HStack(spacing: 12) {
                Button(action: onRetry) { Label("Send", systemImage: "arrow.up.circle") }
                Button(role: .destructive, action: onDiscard) { Label("Discard", systemImage: "trash") }
            }
            .font(.callout)
            .buttonStyle(.borderless)
            .tint(KinicDesign.hotPink)
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .contain)
    }
}

/// A search hit. Comment matches are folded into the parent item and reported as a count.
private struct WorkItemSearchRow: View {
    let result: WorkItemSearchResult

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(result.isUnsupportedVersion ? "Unsupported item version" : result.title)
                .font(.headline)
                .foregroundStyle(result.isUnsupportedVersion ? KinicDesign.bodyGray : Color.primary)
                .lineLimit(2)

            if let snippet = result.snippet, !snippet.isEmpty {
                Text(snippet)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
            }

            if let state = result.state {
                Label(state.displayName, systemImage: state == .open ? "circle" : "checkmark.circle.fill")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if result.matchedCommentCount > 0 {
                Label("\(result.matchedCommentCount) matching comment(s)", systemImage: "bubble.left")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}
