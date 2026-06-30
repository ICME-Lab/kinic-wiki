// Where: mobile/ios/KinicShareExtension/ShareQueueRecord.swift
// What: Codable storage record written by the Share Extension.
// Why: The extension should persist typed queue data for the app to read.

import Foundation

struct ShareQueueRecord: Codable, Equatable, Sendable {
    let url: String
    let receivedAt: Date
}

