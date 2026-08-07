// Where: mobile/ios/KinicApp/Services/VFSCandidError.swift
// What: Explicit errors for the tiny VFS Candid codec.
// Why: Unsupported wire shapes must fail loudly instead of corrupting canister calls.

import Foundation

enum VFSNodeMutationErrorCode: String, Equatable, Sendable {
    case etagConflict
    case notFound
    case forbidden
    case writeUnavailable
    case invalidOperation
}

struct VFSNodeMutationFailure: Equatable, Sendable {
    let code: VFSNodeMutationErrorCode
    let message: String
    let failedIndex: UInt32?
    let conflictPath: String?
}

enum VFSCandidError: Error, LocalizedError, Equatable {
    case invalidPayload(String)
    case canisterRejected(String)
    case nodeMutationRejected(VFSNodeMutationFailure)

    var errorDescription: String? {
        switch self {
        case .invalidPayload(let context):
            "VFS Candid payload is invalid: \(context)."
        case .canisterRejected(let message):
            message
        case .nodeMutationRejected(let failure):
            failure.message
        }
    }
}
