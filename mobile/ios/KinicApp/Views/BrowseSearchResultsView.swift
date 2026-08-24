// Where: mobile/ios/KinicApp/Views/BrowseSearchResultsView.swift
// What: Search result list for the selected readable database.
// Why: Searches should stay scoped to the current DB and navigate to folders or documents.

import SwiftUI

struct BrowseSearchResultsView: View {
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Bindable var model: AppModel
    let folderPath: String
    @Binding var selectedDocumentPath: String?
    let openFolder: (String) -> Void

    var body: some View {
        if shouldShowResults {
            resultRows
            resultFooter
        } else {
            switch model.browseSearchPhase {
            case .idle, .debouncing, .loading, .loadingMore:
                ProgressView("Searching…")
                    .tint(KinicDesign.hotPink)
            case .empty, .results:
                ContentUnavailableView.search
            case .failure(let message):
                searchFailure(message)
            }
        }
    }

    private var shouldShowResults: Bool {
        !model.searchResults.isEmpty
    }

    @ViewBuilder
    private var resultRows: some View {
        ForEach(model.searchResults) { hit in
            if hit.kind == .folder {
                Button(action: { openFolder(hit.path) }) {
                    BrowseSearchResultRow(hit: hit, query: model.searchQuery)
                }
                .buttonStyle(.plain)
            } else if horizontalSizeClass == .compact {
                NavigationLink(value: BrowseFolderRoute.document(path: hit.path)) {
                    BrowseSearchResultRow(hit: hit, query: model.searchQuery)
                }
            } else {
                Button(action: { openDocument(hit.path) }) {
                    BrowseSearchResultRow(hit: hit, query: model.searchQuery)
                }
                .buttonStyle(.plain)
            }
        }
    }

    @ViewBuilder
    private var resultFooter: some View {
        switch model.browseSearchPhase {
        case .loadingMore:
            HStack {
                Spacer()
                ProgressView("Loading more…")
                    .tint(KinicDesign.hotPink)
                Spacer()
            }
        case .failure(let message):
            VStack(alignment: .leading) {
                Label(message, systemImage: "exclamationmark.triangle")
                    .foregroundStyle(.secondary)
                Button("Retry", systemImage: "arrow.clockwise") {
                    model.retryBrowseSearch(folderPath: folderPath)
                }
            }
        default:
            if model.canLoadMoreBrowseSearchResults {
                Button("Show More Results", systemImage: "chevron.down") {
                    model.loadMoreBrowseSearchResults(folderPath: folderPath)
                }
            }
        }
    }

    private func searchFailure(_ message: String) -> some View {
        ContentUnavailableView {
            Label("Search Failed", systemImage: "exclamationmark.magnifyingglass")
        } description: {
            Text(message)
        } actions: {
            Button("Retry", systemImage: "arrow.clockwise") {
                model.retryBrowseSearch(folderPath: folderPath)
            }
        }
    }

    private func openDocument(_ path: String) {
        selectedDocumentPath = path
    }
}
