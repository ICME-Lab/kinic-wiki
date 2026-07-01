// Where: mobile/ios/KinicApp/Services/SourceCaptureRequestError.swift
// What: Validation errors for native source capture request generation.
// Why: Bad request IDs or URLs should be blocked before canister calls.

import Foundation

enum SourceCaptureRequestError: LocalizedError, Equatable {
    case invalidRequestId

    var errorDescription: String? {
        switch self {
        case .invalidRequestId:
            "Source capture request id is invalid."
        }
    }
}

