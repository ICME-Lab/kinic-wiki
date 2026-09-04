// Where: mobile/ios/KinicApp/Services/VFSCandidError.swift
// What: Domain errors returned by VFS Result variants.
// Why: Transport and wire failures belong to ICNativeClient; callers still need VFS rejection details.

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
    case canisterRejected(String)
    case nodeMutationRejected(VFSNodeMutationFailure)

    var errorDescription: String? {
        switch self {
        case .canisterRejected(let message):
            message
        case .nodeMutationRejected(let failure):
            failure.message
        }
    }
}
