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

    var body: some View {
        NavigationSplitView {
            BrowseDatabaseListView(
                model: model,
                selectedDatabaseId: $selectedDatabaseId,
                selectedDocumentPath: $selectedDocumentPath,
                folderPath: $folderPath
            )
        } content: {
            if let selectedDatabaseId {
                BrowseNodeNavigationView(
                    model: model,
                    databaseId: selectedDatabaseId,
                    selectedDocumentPath: $selectedDocumentPath,
                    folderPath: $folderPath
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

    private func applyBrowseNavigationRequest() {
        syncSelectionFromModel()
        switch model.requestedBrowseTarget {
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
