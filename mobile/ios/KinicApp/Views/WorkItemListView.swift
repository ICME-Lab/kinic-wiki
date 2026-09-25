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

private struct WorkItemSearchAnchorKey: PreferenceKey {
    static let defaultValue: Anchor<CGRect>? = nil

    static func reduce(value: inout Anchor<CGRect>?, nextValue: () -> Anchor<CGRect>?) {
        value = nextValue() ?? value
    }
}

struct WorkItemListView: View {
    @Bindable var appModel: AppModel
    @Bindable var model: WorkItemModel
    let askAIModel: AskAIModel
    let openSearchResult: (String) -> Void
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var filter: WorkItemFilter = .open
    @State private var isShowingComposer = false
    @State private var composerDraft: WorkItemComposeRequest?
    @State private var isShowingIngest = false
    @State private var isShowingHistory = false
    @State private var isShowingSearch = false
    @State private var isShowingLocalWork = false
    @State private var capturesExpanded = false
    @State private var pendingDatabaseId: String?
    @State private var discardCapture: WorkItemCaptureRecord?
    @State private var discardMutation: WorkItemPendingMutation?

    private var visibleEntries: [WorkItemListEntry] { model.entries.filter(filter.matches) }
    private var captureSummary: HomeCaptureSummary {
        HomeCaptureSummary(records: appModel.sourceCaptureHistory, databaseId: appModel.selectedDatabaseId)
    }
    private var localWorkCount: Int { model.localCaptures.count + model.pendingMutations.count }

    var body: some View {
        Group {
            if !appModel.isSignedIn || appModel.selectedDatabase == nil { setupSurface }
            else { listSurface }
        }
        .databaseContext(model: appModel)
        .toolbar(.hidden, for: .navigationBar)
        .task {
            appModel.refreshInbox()
            appModel.startRefreshDatabases()
            appModel.autoSubmitPendingURL()
            presentRequestedCompose()
            await model.importQueuedCaptures()
            await refreshHome()
        }
        .onChange(of: appModel.selectedDatabaseId) {
            capturesExpanded = false
            isShowingHistory = false
            isShowingSearch = false
            isShowingLocalWork = false
            filter = .open
            model.clearSearch()
            presentRequestedCompose()
            Task { await refreshHome() }
        }
        .onChange(of: appModel.workItemComposeRequestID) { presentRequestedCompose() }
        .onChange(of: appModel.principalText) {
            isShowingHistory = false
            isShowingSearch = false
            isShowingLocalWork = false
            isShowingComposer = false
            Task { await model.refresh() }
        }
        .sheet(isPresented: $isShowingComposer) {
            WorkItemComposerView(appModel: appModel, model: model, draft: composerDraft)
        }
        .sheet(isPresented: $isShowingIngest) { IngestSheet(model: appModel) }
        .sheet(isPresented: $isShowingHistory) { SourceCaptureHistoryView(model: appModel) }
        .sheet(isPresented: $isShowingLocalWork, onDismiss: {
            if let databaseId = pendingDatabaseId {
                pendingDatabaseId = nil
                _ = appModel.requestBrowseDatabaseSelection(databaseId)
            }
        }) { localWorkView }
    }

    private var setupSurface: some View {
        ScrollView {
            VStack(spacing: 16) {
                if !appModel.isSignedIn { SessionPanel(model: appModel) }
                DatabasePanel(model: appModel)
                if let message = appModel.statusMessage { StatusPanel(message: message) }
            }.padding(KinicDesign.screenPadding)
        }.background(KinicDesign.appBackground)
    }

    private var listSurface: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                primaryActions
                    .padding(.top, 16)
                    .padding(.bottom, 14)

                if !model.canWrite {
                    Label(appModel.selectedDatabase?.status == .pending ? "This database needs credits before it can be used." : "Read-only access to this database.", systemImage: "lock")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .padding(.bottom, 12)
                }
                recentCaptures
                    .padding(.bottom, 20)

                HStack(alignment: .firstTextBaseline) {
                    Text("Work items").font(.title2.weight(.bold))
                    Spacer()
                    if model.phase == .ready {
                        Text("\(visibleEntries.count)")
                            .font(.subheadline.monospacedDigit())
                            .foregroundStyle(.secondary)
                    }
                    Button("Search work items", systemImage: "magnifyingglass") {
                        isShowingSearch = true
                    }
                    .labelStyle(.iconOnly)
                    .frame(minWidth: 44, minHeight: 44)
                    .accessibilityIdentifier("home.search")
                }
                .padding(.bottom, 8)
                .anchorPreference(key: WorkItemSearchAnchorKey.self, value: .bounds) { $0 }

                if localWorkCount > 0 {
                    Button("On this device · \(localWorkCount)") { isShowingLocalWork = true }
                        .font(.subheadline)
                        .accessibilityIdentifier("home.localWork")
                        .frame(minHeight: 44)
                }
                if let message = model.actionError {
                    StatusPanel(message: message).padding(.bottom, 12)
                }
                Picker("Filter", selection: $filter) {
                    ForEach(WorkItemFilter.allCases) { option in Text(option.displayName).tag(option) }
                }
                .pickerStyle(.segmented)
                .padding(.bottom, 8)
                itemsContent
                }
                .frame(maxWidth: 760)
                .frame(maxWidth: .infinity)
                .padding(.horizontal, KinicDesign.screenPadding)
                .padding(.bottom, 24)
        }
        .background(KinicDesign.appBackground)
        .overlayPreferenceValue(WorkItemSearchAnchorKey.self) { anchor in
            GeometryReader { geometry in
                if isShowingSearch, let anchor {
                    let frame = geometry[anchor]
                    WorkItemSearchOverlay(model: model, onClose: { isShowingSearch = false }) { itemId in
                        isShowingSearch = false
                        openSearchResult(itemId)
                    }
                    .frame(width: frame.width)
                    .offset(x: frame.minX, y: frame.minY)
                }
            }
        }
        .scrollDismissesKeyboard(.interactively)
        .refreshable { await refreshHome(force: true) }
        .navigationDestination(for: String.self) { itemId in
            WorkItemDetailView(model: model, appModel: appModel, itemId: itemId)
        }
    }

    private var primaryActions: some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 8) { actionButtons }
            } else {
                HStack(spacing: 8) { actionButtons }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder private var actionButtons: some View {
        Button(action: newItem) {
            Label("New item", systemImage: "plus")
                .font(.subheadline.weight(.semibold))
                .padding(.horizontal, 16)
                .frame(minHeight: 44)
                .foregroundStyle(.white)
                .background(KinicDesign.hotPink, in: RoundedRectangle(cornerRadius: 12))
        }
        .buttonStyle(.plain)
        .disabled(!model.canWrite)
        .opacity(model.canWrite ? 1 : 0.45)
        .accessibilityIdentifier("home.newItem")

        Button { isShowingIngest = true } label: {
            Label("Save URL", systemImage: "link")
                .font(.subheadline.weight(.semibold))
                .padding(.horizontal, 16)
                .frame(minHeight: 44)
                .foregroundStyle(KinicDesign.hotPink)
                .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
        }
        .buttonStyle(.plain)
        .disabled(!model.canWrite)
        .opacity(model.canWrite ? 1 : 0.45)
        .accessibilityIdentifier("home.saveURL")
    }

    private var recentCaptures: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Button { capturesExpanded.toggle() } label: {
                    HStack(spacing: 8) {
                        Image(systemName: capturesExpanded ? "chevron.down" : "chevron.right")
                            .font(.caption.weight(.semibold))
                        Text("Recent captures")
                            .font(.subheadline.weight(.semibold))
                        Spacer(minLength: 0)
                    }
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("home.recentCaptures")
                .accessibilityValue(capturesExpanded ? "Expanded" : "Collapsed")

                Button("See all") { isShowingHistory = true }
                    .font(.subheadline.weight(.medium))
                    .frame(minWidth: 44, minHeight: 44)
                    .accessibilityIdentifier("home.captureHistory")
                    .accessibilityLabel("Capture history")
            }
            if let latest = captureSummary.recent.first {
                Text("\(latest.item.status.displayTitle) · \(latest.item.url)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .padding(.leading, 20)
            } else {
                Text(appModel.isLoadingSourceCaptureHistory ? "Loading history…" : "No captures yet")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.leading, 20)
            }
            if capturesExpanded {
                Divider().padding(.vertical, 8)
                ForEach(captureSummary.recent) { record in captureRow(record) }
                if captureSummary.recent.isEmpty {
                    Text("Save a URL to build your Wiki.").font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14))
    }

    private func captureRow(_ record: SourceCaptureHistoryRecord) -> some View {
        SourceCaptureHistoryRow(item: record.item, databaseTitle: appModel.selectedDatabase?.displayTitle ?? record.databaseId,
            openTarget: { isShowingLocalWork = false; appModel.openSourceCaptureTarget($0) },
            retry: { Task { await appModel.retrySourceCapture(record) } },
            isRetrying: appModel.isRetryingSourceCapture(path: record.item.requestPath),
            canRetry: model.canWrite)
    }

    private var itemsContent: some View {
        VStack(alignment: .leading, spacing: 0) {
            if visibleEntries.isEmpty { emptyItems }
            ForEach(visibleEntries) { entry in
                NavigationLink(value: entry.id) {
                    HStack(spacing: 12) {
                        WorkItemRow(entry: entry)
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.right")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.tertiary)
                    }
                    .frame(maxWidth: .infinity, minHeight: 60, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                Divider()
            }
            listFooter
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(.top, 10)
        }
    }

    @ViewBuilder private var emptyItems: some View {
        switch model.phase {
        case .loading:
            ProgressView("Loading work items…")
        case .failed:
            ContentUnavailableView {
                Label("Could not load work items", systemImage: "wifi.exclamationmark")
            } actions: {
                Button("Try again") { Task { await refreshHome(force: true) } }
            }
        default:
            VStack(alignment: .leading, spacing: 10) {
                Text(filter == .closed ? "No closed items" : filter == .open && !model.entries.isEmpty ? "All caught up" : "Your work starts here")
                    .font(.headline)
                Text(filter == .closed ? "Items you close will appear here." : "Keep notes, tasks, and source links together in this database.")
                    .foregroundStyle(.secondary)
                if filter != .closed && model.canWrite {
                    Button("Create an item", systemImage: "plus", action: newItem).frame(minHeight: 44)
                }
            }.padding(.vertical, 8)
        }
    }

    private var localWorkView: some View {
        NavigationStack {
            List {
                if let error = model.actionError { Section { StatusPanel(message: error) } }
                if !model.localCaptures.isEmpty {
                    Section("Work items on this device") {
                        ForEach(model.localCaptures) { capture in localCaptureRow(capture) }
                    }
                }
                if !model.pendingMutations.isEmpty { pendingSection }
                if localWorkCount == 0 { Text("Nothing waiting to send.") }
            }
            .navigationTitle("On this device")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { isShowingLocalWork = false } } }
            .confirmationDialog("Discard this local item?", isPresented: Binding(get: { discardCapture != nil }, set: { if !$0 { discardCapture = nil } }), presenting: discardCapture) { capture in
                Button("Discard", role: .destructive) {
                    model.discardLocalCapture(capture.captureId)
                    discardCapture = nil
                }
            } message: { _ in Text("This item has not been sent to its database.") }
            .confirmationDialog("Discard these unsent changes?", isPresented: Binding(get: { discardMutation != nil }, set: { if !$0 { discardMutation = nil } }), titleVisibility: .visible, presenting: discardMutation) { mutation in
                Button("Discard changes", role: .destructive) {
                    model.discardPendingMutation(mutation.mutationId)
                    discardMutation = nil
                }
            }
        }
    }

    private func localCaptureRow(_ capture: WorkItemCaptureRecord) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(capture.provisionalTitle.isEmpty ? capture.rawText : capture.provisionalTitle).font(.headline).lineLimit(2)
            Label("Saved on this device only", systemImage: "iphone").font(.caption).foregroundStyle(.secondary)
            Text(capture.databaseId.map { id in appModel.browseListDatabases.first { $0.databaseId == id }?.displayTitle ?? id } ?? "No database chosen")
                .font(.caption).foregroundStyle(.secondary)
            HStack {
                if capture.databaseId == nil {
                    Menu("Choose destination") {
                        ForEach(appModel.browseListDatabases.filter(\.canWrite)) { database in
                            Button(database.displayTitle) { model.assignDestination(captureId: capture.captureId, databaseId: database.databaseId) }
                        }
                    }
                } else if capture.databaseId != appModel.selectedDatabaseId {
                    Button("Switch to this database") {
                        pendingDatabaseId = capture.databaseId
                        isShowingLocalWork = false
                    }.disabled(appModel.databaseSelectionLocked || !appModel.browseListDatabases.contains { $0.databaseId == capture.databaseId })
                } else {
                    Button("Send") { Task { await model.retryLocalCapture(capture.captureId) } }.disabled(!model.canWrite)
                }
                Spacer()
                Button("Discard", role: .destructive) { discardCapture = capture }
            }.buttonStyle(.borderless).frame(minHeight: 44)
        }.padding(.vertical, 4)
    }

    private func newItem() { composerDraft = nil; isShowingComposer = true }
    private func refreshHome(force: Bool = false) async {
        async let items: Void = model.refresh(force: force)
        async let captures: Void = appModel.refreshSourceCaptureHistory(refreshAll: force)
        _ = await (items, captures)
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
                    .disabled(!model.canWrite)
                    .frame(minWidth: 44, minHeight: 44)
                    Button("Discard", role: .destructive) {
                        discardMutation = mutation
                    }.frame(minWidth: 44, minHeight: 44)
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

/// A compact search box positioned over the Work items heading.
private struct WorkItemSearchOverlay: View {
    @Bindable var model: WorkItemModel
    let onClose: () -> Void
    let onSelect: (String) -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField("Search work items", text: $model.searchQuery)
                    .submitLabel(.search)
                    .accessibilityIdentifier("home.searchField")
                Button("Close search", systemImage: "xmark") { onClose() }
                    .labelStyle(.iconOnly)
                    .frame(minWidth: 44, minHeight: 44)
            }
            .padding(.leading, 16)
            .padding(.trailing, 4)
            .frame(minHeight: 52)

            if !model.searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Divider()
                switch model.searchPhase {
                case .idle, .searching:
                    ProgressView("Searching…")
                        .frame(maxWidth: .infinity, minHeight: 56, alignment: .leading)
                        .padding(.horizontal, 16)
                case .empty:
                    Text("No work items found")
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, minHeight: 56, alignment: .leading)
                        .padding(.horizontal, 16)
                case .failed(let message):
                    Text(message)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, minHeight: 56, alignment: .leading)
                        .padding(.horizontal, 16)
                case .results:
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            ForEach(model.searchSnapshot.results) { result in
                                Button { onSelect(result.id) } label: {
                                    WorkItemSearchRow(result: result)
                                        .frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
                                        .padding(.horizontal, 16)
                                        .padding(.vertical, 6)
                                }
                                .buttonStyle(.plain)
                                .accessibilityIdentifier("home.searchResult.\(result.id)")
                                Divider().padding(.leading, 16)
                            }
                            if model.searchSnapshot.isCapped {
                                Text("Narrow the search to find older items.")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .padding(16)
                            }
                        }
                    }
                    .frame(maxHeight: 320)
                }
            }
        }
        .background(Color(uiColor: .systemBackground), in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Color(uiColor: .separator).opacity(0.3)))
        .shadow(color: .black.opacity(0.15), radius: 18, y: 8)
        .task { model.clearSearch() }
        .task(id: model.searchQuery) {
            let query = model.searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !query.isEmpty else { model.clearSearchResults(); return }
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            await model.search(query)
        }
        .onDisappear { model.clearSearch() }
    }
}
