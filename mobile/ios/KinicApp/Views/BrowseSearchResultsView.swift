// Where: mobile/ios/KinicApp/Views/BrowseSearchResultsView.swift
// What: Search result list for the selected readable database.
// Why: Searches should stay scoped to the current DB and navigate to folders or documents.

import SwiftUI

struct BrowseSearchResultsView: View {
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Bindable var model: AppModel
    @Binding var selectedDocumentPath: String?
    @Binding var selectedManageDatabaseId: String?

    var body: some View {
        if model.isSearching {
            ProgressView()
                .tint(KinicDesign.hotPink)
        } else if model.searchResults.isEmpty {
            ContentUnavailableView.search
        } else {
            ForEach(model.searchResults) { hit in
                if hit.kind == .folder {
                    NavigationLink(value: BrowseFolderRoute(path: hit.path)) {
                        BrowseSearchResultRow(hit: hit)
                    }
                } else {
                    if horizontalSizeClass == .compact {
                        NavigationLink(value: BrowseFolderRoute.document(path: hit.path)) {
                            BrowseSearchResultRow(hit: hit)
                        }
                    } else {
                        Button(action: { openDocument(hit.path) }) {
                            BrowseSearchResultRow(hit: hit)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }

    private func openDocument(_ path: String) {
        selectedDocumentPath = path
        selectedManageDatabaseId = nil
        model.startLoadBrowseDocument(path)
    }
}
