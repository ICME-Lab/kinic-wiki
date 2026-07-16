// Where: mobile/ios/KinicApp/Models/ShareCaptureResult.swift
// What: Result of a Share Extension source-capture attempt.
// Why: The extension UI needs to distinguish saved, queued-for-later, and unrecoverable failures.

import Foundation

enum ShareCaptureResult: Equatable, Sendable {
    case saved(requestPath: String)
    case savedPendingRetry(requestPath: String)
    case queued(reason: String)
    case failed(message: String)

    var shareExtensionTitleText: String {
        switch self {
        case .saved:
            "Capture started"
        case .savedPendingRetry:
            "Saved, retry required"
        case .queued:
            "Saved for later"
        case .failed:
            "Could not complete capture"
        }
    }

    var shareExtensionMessageText: String {
        switch self {
        case .saved:
            "KinicWiki is generating the source capture."
        case .savedPendingRetry:
            "The request was saved, but capture could not start. Open KinicWikiApp and retry it from Capture history."
        case let .queued(reason):
            reason
        case let .failed(message):
            message
        }
    }
}
