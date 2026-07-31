// Where: mobile/ios/KinicApp/Models/PendingDatabaseActivation.swift
// What: Typed presentation state for a database awaiting its first cycles purchase.
// Why: Pending creation needs a durable funding action instead of a transient status message.

import Foundation

struct PendingDatabaseActivation: Identifiable, Equatable, Sendable {
    let databaseId: String
    let databaseName: String
    let fundingURL: URL

    var id: String {
        databaseId
    }
}
