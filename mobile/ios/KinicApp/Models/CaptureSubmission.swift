// Where: mobile/ios/KinicApp/Models/CaptureSubmission.swift
// What: Result returned after a source capture request is persisted.
// Why: The UI needs a compact value rather than raw canister reply bytes.

import Foundation

struct CaptureSubmission: Equatable, Sendable {
    let databaseId: String
    let requestPath: String
    let requestId: String
    let url: URL
}
