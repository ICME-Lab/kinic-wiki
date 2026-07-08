// Where: mobile/ios/KinicApp/Models/SharedURLRecord.swift
// What: Codable storage record for one queued Share Extension URL file.
// Why: One file per queued URL avoids cross-process lost updates from read-modify-write arrays.

import Foundation

struct SharedURLRecord: Codable, Equatable, Sendable {
    let id: String
    let url: String
    let receivedAt: Date
    let requestId: String
    let captureMetadata: ShareCaptureMetadata?

    init(
        id: String,
        url: String,
        receivedAt: Date,
        requestId: String,
        captureMetadata: ShareCaptureMetadata? = nil
    ) {
        self.id = id
        self.url = url
        self.receivedAt = receivedAt
        self.requestId = requestId
        self.captureMetadata = captureMetadata
    }
}
