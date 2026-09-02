// Where: mobile/ios/KinicApp/Views/BrowseView.swift
// What: Root split navigation for browsing readable Kinic Wiki databases.
// Why: The Browse tab should behave like iOS Notes: databases, note lists, then document detail.

import SwiftUI

struct BrowseView: View {
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Bindable var model: AppModel
    let rootNavigationID: Int
    @State private var selectedDatabaseId: String?
    @State private var selectedDocumentPath: String?
    @State private var folderPath: [BrowseFolderRoute] = []
    @State private var isBrowseSearchPresented = false
    @State private var navigationGate = BrowseNavigationGate()

    var body: some View {
        NavigationSplitView {
            BrowseDatabaseListView(
                model: model,
                selectedDatabaseId: selectedDatabaseBinding,
                selectedDocumentPath: selectedDocumentPathBinding,
                folderPath: $folderPath
            )
        } content: {
            if let selectedDatabaseId {
                BrowseNodeNavigationView(
                    model: model,
                    databaseId: selectedDatabaseId,
                    selectedDocumentPath: selectedDocumentPathBinding,
                    folderPath: $folderPath,
                    isSearchPresented: $isBrowseSearchPresented,
                    requestSearchFolder: requestSearchFolder
                )
            } else {
                ContentUnavailableView("Select a database", systemImage: "externaldrive")
            }
        } detail: {
            if let selectedDocumentPath {
                BrowseDocumentView(model: model, path: selectedDocumentPath)
            } else {
                ContentUnavailableView("Select a node", systemImage: "doc.text")
            }
        }
        .navigationSplitViewStyle(.balanced)
        .confirmationDialog(
            "Discard unsaved changes?",
            isPresented: pendingNavigationPresented,
            titleVisibility: .visible
        ) {
            Button("Discard Changes", role: .destructive, action: applyPendingNavigation)
            Button("Continue Editing", role: .cancel, action: cancelPendingNavigation)
        } message: {
            Text("Your Markdown changes have not been saved.")
        }
        .task {
            model.startRefreshDatabases()
            syncSelectionFromModel()
            applyBrowseNavigationRequest()
        }
        .onChange(of: model.selectedBrowseDatabaseId) {
            syncSelectionFromModel()
        }
        .onChange(of: rootNavigationID) {
            applyBrowseNavigationRequest()
        }
        .onChange(of: model.browseNavigationRequestID) {
            applyBrowseNavigationRequest()
        }
        .onChange(of: horizontalSizeClass) { _, newSizeClass in
            adaptNavigation(to: newSizeClass)
        }
        .onChange(of: folderPath) { _, newPath in
            syncCompactDocumentSelection(with: newPath)
        }
    }

    private func syncSelectionFromModel() {
        let databaseId = model.selectedBrowseDatabaseId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !databaseId.isEmpty else {
            selectedDatabaseId = nil
            selectedDocumentPath = nil
            folderPath = []
            return
        }
        selectedDatabaseId = databaseId
    }

    private var selectedDatabaseBinding: Binding<String?> {
        Binding(
            get: { selectedDatabaseId },
            set: { databaseId in requestDatabaseSelection(databaseId) }
        )
    }

    private var selectedDocumentPathBinding: Binding<String?> {
        Binding(
            get: { selectedDocumentPath },
            set: { path in requestDocumentSelection(path) }
        )
    }

    private var pendingNavigationPresented: Binding<Bool> {
        Binding(
            get: { navigationGate.pendingRequest != nil },
            set: { presented in
                if !presented {
                    cancelPendingNavigation()
                }
            }
        )
    }

    private func requestDatabaseSelection(_ databaseId: String?) {
        guard databaseId != selectedDatabaseId else { return }
        guard let databaseId else {
            requestNavigation(.database(nil))
            return
        }
        _ = model.requestBrowseDatabaseSelection(databaseId)
    }

    private func requestDocumentSelection(_ path: String?) {
        guard path != selectedDocumentPath else { return }
        requestNavigation(.document(path))
    }

    private func requestSearchFolder(_ path: String) {
        requestNavigation(.searchFolder(AppModel.normalizedBrowsePath(path)))
    }

    private func requestNavigation(_ request: BrowseNavigationGate.Request) {
        let previousPendingRequest = navigationGate.pendingRequest
        let requestToApply = navigationGate.request(
            request,
            hasUnsavedChanges: model.documentEditSession?.hasChanges == true
        )
        if previousPendingRequest != navigationGate.pendingRequest {
            cancelExternalRequestIfNeeded(previousPendingRequest)
        }
        if let requestToApply {
            apply(requestToApply)
        }
    }

    private func applyPendingNavigation() {
        guard let pendingRequest = navigationGate.confirm() else { return }
        model.discardBrowseDocumentEdits()
        apply(pendingRequest)
    }

    private func cancelPendingNavigation() {
        cancelExternalRequestIfNeeded(navigationGate.cancel())
    }

    private func cancelExternalRequestIfNeeded(_ request: BrowseNavigationGate.Request?) {
        switch request {
        case .databaseSelection(let selectionRequest):
            model.cancelBrowseDatabaseSelection(selectionRequest)
        case .deepLink(let deepLinkRequest):
            model.cancelBrowseDeepLink(deepLinkRequest)
        default:
            return
        }
    }

    private func apply(_ navigation: BrowseNavigationGate.Request) {
        if model.documentEditSession != nil {
            model.discardBrowseDocumentEdits()
        }
        switch navigation {
        case .database(let databaseId):
            selectedDatabaseId = databaseId
            selectedDocumentPath = nil
            folderPath = []
            if let databaseId, databaseId != model.selectedBrowseDatabaseId {
                model.selectBrowseDatabase(databaseId)
            }
        case .databaseSelection(let request):
            model.applyBrowseDatabaseSelection(request)
        case .document(let path):
            selectedDocumentPath = path
            if let path {
                model.startLoadBrowseDocument(path)
            }
        case .target(let target):
            apply(target)
        case .searchFolder(let path):
            isBrowseSearchPresented = false
            model.clearBrowseSearch()
            selectedDocumentPath = nil
            folderPath = AppModel.browseNavigationRoutes(
                for: .folder(path),
                includeDocument: false
            )
        case .deepLink(let request):
            model.applyBrowseDeepLink(request)
        }
    }

    private func applyBrowseNavigationRequest() {
        syncSelectionFromModel()
        if let request = model.requestedBrowseDeepLink {
            requestNavigation(.deepLink(request))
        } else if let request = model.requestedBrowseDatabaseSelection {
            requestNavigation(.databaseSelection(request))
        } else {
            requestNavigation(.target(model.requestedBrowseTarget))
        }
    }

    private func apply(_ target: BrowseNavigationTarget) {
        switch target {
        case let .folder(path):
            selectedDocumentPath = nil
            folderPath = AppModel.browseNavigationRoutes(
                for: .folder(path),
                includeDocument: false
            )
        case let .document(path, parentPath):
            selectedDocumentPath = path
            folderPath = AppModel.browseNavigationRoutes(
                for: .document(path: path, parentPath: parentPath),
                includeDocument: horizontalSizeClass == .compact
            )
        }
    }

    private func adaptNavigation(to sizeClass: UserInterfaceSizeClass?) {
        switch sizeClass {
        case .compact:
            guard let selectedDocumentPath else { return }
            folderPath = AppModel.browseNavigationRoutes(
                for: .document(
                    path: selectedDocumentPath,
                    parentPath: AppModel.parentPath(selectedDocumentPath)
                ),
                includeDocument: true
            )
        case .regular:
            guard folderPath.last?.kind == .document else { return }
            selectedDocumentPath = folderPath.removeLast().path
        default:
            return
        }
    }

    private func syncCompactDocumentSelection(with path: [BrowseFolderRoute]) {
        guard horizontalSizeClass == .compact else { return }
        if let route = path.last, route.kind == .document {
            selectedDocumentPath = route.path
        } else {
            selectedDocumentPath = nil
        }
    }
}

#Preview {
    BrowseView(model: .preview(), rootNavigationID: 0)
}
