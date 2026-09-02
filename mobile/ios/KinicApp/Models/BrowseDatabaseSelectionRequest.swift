// Where: mobile/ios/KinicApp/Models/BrowseDatabaseSelectionRequest.swift
// What: A database selection that may wait for an unsaved-draft decision.
// Why: Cross-tab database changes must not mutate Browse state before confirmation.

import Foundation

struct BrowseDatabaseSelectionRequest: Identifiable, Equatable, Sendable {
    let id: UUID
    let databaseId: String
}

enum BrowseDatabaseSelectionDisposition: Equatable, Sendable {
    case unchanged
    case applied
    case awaitingDiscard(BrowseDatabaseSelectionRequest)
}

struct BrowseDatabaseSelectionResolution: Equatable, Sendable {
    enum Outcome: Equatable, Sendable {
        case applied
        case cancelled
    }

    let requestId: UUID
    let databaseId: String
    let outcome: Outcome
}
