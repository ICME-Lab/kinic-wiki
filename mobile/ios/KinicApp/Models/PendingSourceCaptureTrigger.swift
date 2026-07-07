// Where: mobile/ios/KinicApp/Models/PendingSourceCaptureTrigger.swift
// What: Stored source-capture trigger waiting for worker acceptance.
// Why: UI completion should depend on request persistence, not worker availability.

import Foundation

struct PendingSourceCaptureTrigger: Identifiable, Equatable, Sendable {
    let id: String
    let databaseId: String
    let requestPath: String
    let requestId: String
    let url: URL
    let sessionNonce: String
    let createdAt: Date
    let lastError: String?
}
