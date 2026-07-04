// Where: mobile/ios/KinicApp/Models/PendingSharedURL.swift
// What: URL item received through the Share Extension.
// Why: Share Extension writes are reviewed by the app before canister submission.

import Foundation

struct PendingSharedURL: Identifiable, Equatable, Sendable {
    let id: String
    let url: URL
    let receivedAt: Date
    let requestId: String
}
