// Where: mobile/ios/KinicApp/Models/BrowseSearch.swift
// What: Native browse-search request, scope, and presentation state.
// Why: Search UI must distinguish pending, successful, empty, and failed requests.

import Foundation

enum BrowseSearchScope: String, CaseIterable, Identifiable, Sendable {
    case database
    case currentFolder

    var id: Self {
        self
    }

    var title: String {
        switch self {
        case .database:
            "All Database"
        case .currentFolder:
            "Current Folder"
        }
    }

    func prefix(for folderPath: String) -> String? {
        switch self {
        case .database:
            nil
        case .currentFolder:
            AppModel.normalizedBrowsePath(folderPath)
        }
    }
}

enum BrowseSearchPhase: Equatable, Sendable {
    case idle
    case debouncing
    case loading
    case results
    case empty
    case failure(String)
    case loadingMore
}

struct BrowseSearchRequest: Equatable, Sendable {
    let databaseId: String
    let query: String
    let prefix: String?
    let limit: UInt32
}
