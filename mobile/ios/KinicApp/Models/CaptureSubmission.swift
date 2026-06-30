// Where: mobile/ios/KinicApp/Models/CaptureSubmission.swift
// What: Submission result returned after a source capture request is written.
// Why: The UI needs a compact value rather than raw canister reply bytes.

import Foundation

struct CaptureSubmission: Equatable, Sendable {
    let requestPath: String
    let triggered: Bool
    let triggerError: String?
}

