// Where: mobile/ios/KinicApp/Services/VFSCandidError.swift
// What: Explicit errors for the tiny VFS Candid codec.
// Why: Unsupported wire shapes must fail loudly instead of corrupting canister calls.

import Foundation

enum VFSCandidError: Error, LocalizedError, Equatable {
    case invalidPayload(String)
    case canisterRejected(String)

    var errorDescription: String? {
        switch self {
        case .invalidPayload(let context):
            "VFS Candid payload is invalid: \(context)."
        case .canisterRejected(let message):
            message
        }
    }
}
