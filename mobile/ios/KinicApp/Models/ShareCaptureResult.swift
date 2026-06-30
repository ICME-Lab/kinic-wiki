// Where: mobile/ios/KinicApp/Models/ShareCaptureResult.swift
// What: Result of a Share Extension source-capture attempt.
// Why: The extension UI needs to distinguish saved, queued-for-later, and unrecoverable failures.

import Foundation

enum ShareCaptureResult: Equatable, Sendable {
    case saved(requestPath: String, triggerError: String?)
    case queued(reason: String)
    case failed(message: String)
}
