// Where: mobile/ios/KinicApp/Models/SourceCaptureRequest.swift
// What: Native representation of the VFS source capture request node.
// Why: Canister submission should operate on typed data, not ad hoc strings.

import Foundation

struct SourceCaptureRequest: Equatable, Sendable {
    let databaseId: String
    let requestPath: String
    let content: String
    let metadataJson: String
    let normalizedURL: URL
}

