// Where: mobile/ios/KinicApp/Models/SourceCaptureTriggerRecord.swift
// What: Codable disk representation of a pending source-capture trigger.
// Why: App and Share Extension processes need a stable retry record.

import Foundation

struct SourceCaptureTriggerRecord: Codable, Equatable, Sendable {
    let databaseId: String
    let requestPath: String
    let requestId: String
    let url: String
    let sessionNonce: String
    let createdAt: Date
    let lastError: String?
}
