// Where: mobile/ios/KinicApp/Views/BrowseView.swift
// What: Root split navigation for browsing readable Kinic Wiki databases.
// Why: The Browse tab should behave like iOS Notes: databases, note lists, then document detail.

import SwiftUI

struct BrowseView: View {
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
            folderPath = AppModel.folderRoutes(to: path)
        case let .document(path, parentPath):
            selectedDocumentPath = path
            folderPath = AppModel.folderRoutes(to: parentPath)
        }
    }
}

#Preview {
    BrowseView(model: .preview(), rootNavigationID: 0)
}
