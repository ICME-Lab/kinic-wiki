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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
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

    @State private var visibleLimit = 100
    private var filteredEntries: [WorkItemListEntry] { model.entries.filter(filter.matches) }
    private var visibleEntries: [WorkItemListEntry] { Array(filteredEntries.prefix(visibleLimit)) }
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
        .onChange(of: filter) { visibleLimit = 100 }
        .onChange(of: appModel.selectedDatabaseId) {
            visibleLimit = 100
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

    @ViewBuilder private var setupSurface: some View {
        if !appModel.isSignedIn {
            ScrollView {
                SessionPanel(model: appModel)
                    .padding(.horizontal, 24)
                    .padding(.bottom, 32)
                    .frame(maxWidth: .infinity)
            }
            .scrollBounceBehavior(.basedOnSize)
            .background { KinicAurora().ignoresSafeArea() }
        } else {
            ScrollView {
                VStack(spacing: 16) {
                    DatabasePanel(model: appModel)
                    if let message = appModel.statusMessage { StatusPanel(message: message) }
                }.padding(KinicDesign.screenPadding)
            }.background(KinicDesign.appBackground)
        }
    }

    private var greeting: String {
        switch Calendar.current.component(.hour, from: .now) {
        case 5..<12: "Good morning"
        case 12..<18: "Good afternoon"
        default: "Good evening"
        }
    }

    private var openCount: Int { model.entries.filter { $0.state == .open }.count }

    private var heroHeader: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(Date.now.formatted(.dateTime.weekday(.wide).month(.wide).day()).uppercased())
                .font(.caption.weight(.semibold))
                .tracking(1.2)
                .foregroundStyle(KinicDesign.bodyGray)
            Text(greeting)
                .font(.system(.largeTitle, weight: .bold))
            if model.phase == .ready {
                Text(openCount == 0 ? "Nothing open. A clear mind." : openCount == 1 ? "1 open item waiting for you." : "\(openCount) open items waiting for you.")
                    .font(.subheadline)
                    .foregroundStyle(KinicDesign.bodyGray)
                    .contentTransition(.numericText())
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    private var listSurface: some View {
        ScrollViewReader { proxy in
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                heroHeader
                    .padding(.top, 20)
                    .padding(.bottom, 20)
                primaryActions
                    .padding(.bottom, 16)

                if !model.canWrite {
                    Label(appModel.selectedDatabase?.status == .pending ? "This database needs credits before it can be used." : "Read-only access to this database.", systemImage: "lock")
                        .font(.footnote)
                        .foregroundStyle(KinicDesign.bodyGray)
                        .padding(.bottom, 12)
                }
                recentCaptures
                    .padding(.bottom, 28)

                HStack(alignment: .center, spacing: 10) {
                    Text("Work items").font(.title2.weight(.bold))
                    if model.phase == .ready {
                        Text("\(filteredEntries.count)")
                            .font(.subheadline.weight(.semibold).monospacedDigit())
                            .foregroundStyle(KinicDesign.hotPink)
                            .padding(.horizontal, 9)
                            .padding(.vertical, 3)
                            .background(KinicDesign.hotPink.opacity(0.12), in: Capsule())
                            .contentTransition(.numericText())
                    }
                    Spacer()
                    Button("Search work items", systemImage: "magnifyingglass") {
                        isShowingSearch = true
                    }
                    .labelStyle(.iconOnly)
                    .font(.body.weight(.semibold))
                    .frame(width: 40, height: 40)
                    .background(KinicDesign.cardBackground, in: Circle())
                    .frame(minWidth: 44, minHeight: 44)
                    .accessibilityIdentifier("home.search")
                }
                .padding(.bottom, 8)
                .id(Self.workItemsHeaderID)
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
                if let message = model.listAccessError {
                    StatusPanel(message: message).padding(.bottom, 12)
                } else if model.isShowingCachedItems {
                    Label("Showing saved items · Updates unavailable", systemImage: "clock")
                        .font(.caption)
                        .foregroundStyle(KinicDesign.bodyGray)
                        .padding(.bottom, 8)
                }
                Picker("Filter", selection: $filter) {
                    ForEach(WorkItemFilter.allCases) { option in Text(option.displayName).tag(option) }
                }
                .pickerStyle(.segmented)
                .padding(.bottom, 14)
                itemsContent
                    .animation(reduceMotion ? nil : KinicDesign.spring, value: filter)
                }
                .frame(maxWidth: 760)
                .frame(maxWidth: .infinity)
                .padding(.horizontal, KinicDesign.screenPadding + 4)
                .padding(.bottom, 32)
        }
        .background { KinicCanvas() }
        .sensoryFeedback(.selection, trigger: filter)
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
        // The richer header pushes "Work items" down; lift it to the top so results stay above the keyboard.
        .onChange(of: isShowingSearch) { _, showing in
            guard showing else { return }
            withAnimation(reduceMotion ? nil : KinicDesign.spring) {
                proxy.scrollTo(Self.workItemsHeaderID, anchor: .top)
            }
        }
        }
    }

    private static let workItemsHeaderID = "home.workItemsHeader"

    private var primaryActions: some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 12) { actionButtons }
            } else {
                HStack(spacing: 12) { actionButtons }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder private var actionButtons: some View {
        Button(action: newItem) {
            actionTile(title: "New item", subtitle: "Note, task, or idea", symbol: "plus", prominent: true)
        }
        .buttonStyle(KinicPressableStyle())
        .disabled(!model.canWrite)
        .opacity(model.canWrite ? 1 : 0.45)
        .accessibilityLabel("New item")
        .accessibilityIdentifier("home.newItem")

        Button { isShowingIngest = true } label: {
            actionTile(title: "Save URL", subtitle: "Turn a link into a page", symbol: "link", prominent: false)
        }
        .buttonStyle(KinicPressableStyle())
        .disabled(!model.canWrite)
        .opacity(model.canWrite ? 1 : 0.45)
        .accessibilityLabel("Save URL")
        .accessibilityIdentifier("home.saveURL")
    }

    /// A tall tile: icon chip on top, title and hint at the bottom, like a Control Center module.
    @ViewBuilder
    private func actionTile(title: String, subtitle: String, symbol: String, prominent: Bool) -> some View {
        let shape = RoundedRectangle(cornerRadius: KinicDesign.cardRadius, style: .continuous)
        let tile = VStack(alignment: .leading, spacing: 0) {
            Image(systemName: symbol)
                .font(.system(size: 17, weight: .bold))
                .foregroundStyle(prominent ? Color.white : KinicDesign.hotPink)
                .frame(width: 38, height: 38)
                .background(prominent ? AnyShapeStyle(.white.opacity(0.22)) : AnyShapeStyle(KinicDesign.hotPink.opacity(0.12)), in: Circle())
            Spacer(minLength: 18)
            Text(title)
                .font(.headline)
                .foregroundStyle(prominent ? Color.white : Color.primary)
            Text(subtitle)
                .font(.caption)
                .foregroundStyle(prominent ? Color.white.opacity(0.8) : KinicDesign.bodyGray)
                .lineLimit(1)
        }
        .padding(16)
        .frame(maxWidth: .infinity, minHeight: 124, alignment: .leading)
        .contentShape(shape)

        if prominent {
            tile
                .background {
                    shape.fill(KinicDesign.auroraGradient)
                        .overlay { shape.fill(RadialGradient(colors: [.white.opacity(0.28), .clear], center: .topLeading, startRadius: 0, endRadius: 160)) }
                }
        } else {
            tile.kinicCard()
        }
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
                HStack(spacing: 10) {
                    CaptureStatusDot(status: latest.item.status)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(latest.item.status.displayTitle)
                            .font(.caption.weight(.semibold))
                        Text(Self.displayHost(latest.item.url))
                            .font(.caption)
                            .foregroundStyle(KinicDesign.bodyGray)
                            .lineLimit(1)
                    }
                }
                .padding(.leading, 2)
                .padding(.bottom, 4)
                .accessibilityElement(children: .combine)
            } else {
                Text(appModel.isLoadingSourceCaptureHistory ? "Loading history…" : "No captures yet")
                    .font(.caption)
                    .foregroundStyle(KinicDesign.bodyGray)
                    .padding(.leading, 2)
                    .padding(.bottom, 4)
            }
            if capturesExpanded {
                Divider().padding(.vertical, 8)
                ForEach(captureSummary.recent) { record in captureRow(record) }
                if captureSummary.recent.isEmpty {
                    Text("Save a URL to build your Wiki.").font(.caption).foregroundStyle(KinicDesign.bodyGray)
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .kinicCard()
        .animation(reduceMotion ? nil : KinicDesign.spring, value: capturesExpanded)
    }

    /// Shows a link as "example.com/research-notes" — the scheme is noise.
    static func displayHost(_ url: String) -> String {
        guard let components = URLComponents(string: url), let host = components.host else { return url }
        let host2 = host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
        let path = components.path == "/" ? "" : components.path
        return host2 + path
    }

    private func captureRow(_ record: SourceCaptureHistoryRecord) -> some View {
        SourceCaptureHistoryRow(item: record.item, databaseTitle: appModel.selectedDatabase?.displayTitle ?? record.databaseId,
            openTarget: { isShowingLocalWork = false; appModel.openSourceCaptureTarget($0) },
            retry: { Task { await appModel.retrySourceCapture(record) } },
            isRetrying: appModel.isRetryingSourceCapture(path: record.item.requestPath),
            canRetry: model.canWrite)
    }

    private var itemsContent: some View {
        VStack(alignment: .leading, spacing: 10) {
            if visibleEntries.isEmpty { emptyItems }
            ForEach(visibleEntries) { entry in
                NavigationLink(value: entry.id) {
                    HStack(alignment: .top, spacing: 14) {
                        WorkItemStateMark(isClosed: entry.state == .closed)
                            .padding(.top, 10)
                        WorkItemRow(entry: entry)
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.right")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(.tertiary)
                            .padding(.top, 12)
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 6)
                    .frame(maxWidth: .infinity, minHeight: 60, alignment: .leading)
                    .kinicCard(radius: 18)
                    .contentShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                }
                .buttonStyle(KinicPressableStyle(scale: 0.98))
                .transition(.opacity.combined(with: .move(edge: .bottom)))
            }
            if visibleEntries.count < filteredEntries.count {
                Button("Show more items") { visibleLimit += 100 }
                    .frame(minHeight: 44)
            }
            listFooter
                .font(.caption)
                .foregroundStyle(KinicDesign.bodyGray)
                .padding(.top, 10)
        }
    }

    @ViewBuilder private var emptyItems: some View {
        switch model.phase {
        case .loading:
            ProgressView("Loading work items…")
        case .failed(let message):
            ContentUnavailableView {
                Label("Could not load work items", systemImage: "exclamationmark.triangle")
            } description: {
                Text(message)
            } actions: {
                Button("Try again") { Task { await refreshHome(force: true) } }
            }
            if let details = model.listFailureDetails {
                DisclosureGroup("Technical details") {
                    Text(details)
                        .font(.caption)
                        .foregroundStyle(KinicDesign.bodyGray)
                        .textSelection(.enabled)
                }
                .font(.caption)
                .tint(.secondary)
                .foregroundStyle(KinicDesign.bodyGray)
                .padding(.top, 8)
            }
        default:
            VStack(spacing: 14) {
                KinicAuroraOrb(size: 56)
                    .padding(.top, 8)
                Text(filter == .closed ? "No closed items" : filter == .open && !model.entries.isEmpty ? "All caught up" : "Your work starts here")
                    .font(.title3.weight(.semibold))
                Text(filter == .closed ? "Items you close will appear here." : "Keep notes, tasks, and source links together in this database.")
                    .font(.subheadline)
                    .foregroundStyle(KinicDesign.bodyGray)
                    .multilineTextAlignment(.center)
                if filter != .closed && model.canWrite {
                    Button("Create an item", systemImage: "plus", action: newItem)
                        .font(.subheadline.weight(.semibold))
                        .padding(.horizontal, 18)
                        .frame(minHeight: 44)
                        .foregroundStyle(KinicDesign.hotPink)
                        .background(KinicDesign.hotPink.opacity(0.12), in: Capsule())
                        .buttonStyle(KinicPressableStyle())
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 28)
            .padding(.horizontal, 20)
            .kinicCard()
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
            Label("Saved on this device only", systemImage: "iphone").font(.caption).foregroundStyle(KinicDesign.bodyGray)
            Text(capture.databaseId.map { id in appModel.browseListDatabases.first { $0.databaseId == id }?.displayTitle ?? id } ?? "No database chosen")
                .font(.caption).foregroundStyle(KinicDesign.bodyGray)
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
                            .foregroundStyle(KinicDesign.bodyGray)
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

/// Open items show a hollow ring; closed items fill with the brand gradient and a check.
private struct WorkItemStateMark: View {
    let isClosed: Bool

    var body: some View {
        ZStack {
            if isClosed {
                Circle().fill(KinicDesign.auroraGradient)
                Image(systemName: "checkmark")
                    .font(.system(size: 10, weight: .heavy))
                    .foregroundStyle(.white)
            } else {
                Circle().strokeBorder(KinicDesign.hotPink.opacity(0.55), lineWidth: 2)
            }
        }
        .frame(width: 20, height: 20)
        .accessibilityHidden(true)
    }
}

/// A capture's pipeline state, at a glance. In-flight captures pulse softly.
struct CaptureStatusDot: View {
    let status: SourceCaptureHistoryStatus
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pulsing = false

    private var color: Color {
        switch status {
        case .completed: KinicDesign.successGreen
        case .failed: KinicDesign.errorRed
        default: KinicDesign.hotPink
        }
    }

    var body: some View {
        ZStack {
            if status.isProcessing && !reduceMotion {
                Circle()
                    .fill(color.opacity(0.35))
                    .scaleEffect(pulsing ? 2.2 : 1)
                    .opacity(pulsing ? 0 : 1)
            }
            Circle().fill(color)
        }
        .frame(width: 8, height: 8)
        .frame(width: 20, height: 20)
        .onAppear {
            guard status.isProcessing else { return }
            withAnimation(.easeOut(duration: 1.4).repeatForever(autoreverses: false)) { pulsing = true }
        }
        .accessibilityHidden(true)
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

            ViewThatFits(in: .horizontal) {
                metadata
                VStack(alignment: .leading, spacing: 4) { metadataContents }
            }
            .font(.caption)
            .foregroundStyle(KinicDesign.bodyGray)
        }
        .padding(.vertical, 8)
        .accessibilityElement(children: .combine)
        // The leading state ring shows open/closed visually; VoiceOver still hears it.
        .accessibilityValue(entry.state.displayName)
    }

    private var metadata: some View {
        HStack(spacing: 12) { metadataContents }
    }

    @ViewBuilder private var metadataContents: some View {
        Label("\(entry.commentCount)", systemImage: "bubble.left")
        Text(WorkItemListView.date(fromMilliseconds: entry.updatedAt).formatted(.relative(presentation: .named)))
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
                    .foregroundStyle(KinicDesign.bodyGray)
                    .lineLimit(3)
            }

            if let state = result.state {
                Label(state.displayName, systemImage: state == .open ? "circle" : "checkmark.circle.fill")
                    .font(.caption)
                    .foregroundStyle(KinicDesign.bodyGray)
            }

            if result.matchedCommentCount > 0 {
                Label("\(result.matchedCommentCount) matching comment(s)", systemImage: "bubble.left")
                    .font(.caption)
                    .foregroundStyle(KinicDesign.bodyGray)
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
    @FocusState private var isSearchFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Image(systemName: "magnifyingglass").foregroundStyle(KinicDesign.bodyGray)
                TextField("Search work items", text: $model.searchQuery)
                    .focused($isSearchFocused)
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
                        .foregroundStyle(KinicDesign.bodyGray)
                        .frame(maxWidth: .infinity, minHeight: 56, alignment: .leading)
                        .padding(.horizontal, 16)
                case .failed(let message):
                    Text(message)
                        .foregroundStyle(KinicDesign.bodyGray)
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
                                    .foregroundStyle(KinicDesign.bodyGray)
                                    .padding(16)
                            }
                        }
                    }
                    .frame(maxHeight: 320)
                }
            }
        }
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).strokeBorder(.white.opacity(0.25), lineWidth: 0.5))
        .shadow(color: .black.opacity(0.18), radius: 30, y: 14)
        .task { model.clearSearch(); isSearchFocused = true }
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
