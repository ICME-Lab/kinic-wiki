// Where: mobile/ios/KinicApp/Models/SharedURLRecord.swift
// What: Codable storage record for URLs queued by the Share Extension.
// Why: UserDefaults persistence should avoid untyped collection casts.

import Foundation

struct SharedURLRecord: Codable, Equatable, Sendable {
    let url: String
    let receivedAt: Date
}

