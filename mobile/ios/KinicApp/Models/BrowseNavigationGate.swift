// Where: mobile/ios/KinicApp/Models/BrowseNavigationGate.swift
// What: Pending browse navigation that waits for an unsaved-edit decision.
// Why: Navigation side effects must be applied together only after confirmation.

import Foundation

struct BrowseNavigationGate: Equatable {
    enum Request: Equatable {
        case database(String?)
        case databaseSelection(BrowseDatabaseSelectionRequest)
        case document(String?)
        case target(BrowseNavigationTarget)
        case searchFolder(String)
        case deepLink(BrowseDeepLinkRequest)
    }

    private(set) var pendingRequest: Request?

    mutating func request(_ request: Request, hasUnsavedChanges: Bool) -> Request? {
        guard hasUnsavedChanges else {
            pendingRequest = nil
            return request
        }
        pendingRequest = request
        return nil
    }

    mutating func confirm() -> Request? {
        defer { pendingRequest = nil }
        return pendingRequest
    }

    mutating func cancel() -> Request? {
        defer { pendingRequest = nil }
        return pendingRequest
    }
}
