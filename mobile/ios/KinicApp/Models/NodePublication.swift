// Where: mobile/ios/KinicApp/Models/NodePublication.swift
// What: Selected-page publication state returned by the VFS canister.
// Why: Browse actions must distinguish an isolated public page from its database route.

import Foundation

struct NodePublication: Equatable, Sendable {
    let publicId: String
    let databaseId: String
    let path: String
    let publishedAtMs: Int64
}

enum BrowseDocumentPublicationState: Equatable, Sendable {
    case unavailable
    case loading
    case unpublished
    case published(NodePublication)
    case failed(String)
}

enum BrowseDocumentMutation: Equatable, Sendable {
    case save
    case publish
    case unpublish
    case delete
}

struct BrowseDocumentWriteRequest: Equatable, Sendable {
    let databaseId: String
    let path: String
    let kind: VFSNodeKind
    let content: String
    let metadataJson: String
    let expectedEtag: String
}

enum BrowseDocumentEditState: Equatable, Sendable {
    case editing
    case saving
    case conflict(VFSNodeMutationFailure)
}

enum BrowseDocumentWriteRestriction: Equatable, Sendable {
    case accessRemoved
    case permissionLost
    case databaseInactive
    case forbidden
    case writeUnavailable

    var message: String {
        switch self {
        case .accessRemoved:
            "You no longer have access to this database. Your draft was kept."
        case .permissionLost, .forbidden:
            "You no longer have permission to edit this document. Your draft was kept."
        case .databaseInactive, .writeUnavailable:
            "This database is unavailable for writing. Your draft was kept."
        }
    }
}

struct BrowseDocumentEditSession: Equatable, Sendable {
    let databaseId: String
    let path: String
    let originalContent: String
    let originalEtag: String
    let metadataJson: String
    var draftContent: String
    var state: BrowseDocumentEditState
    var writeRestriction: BrowseDocumentWriteRestriction?

    var hasChanges: Bool {
        draftContent != originalContent
    }
}

enum BrowseDocumentSaveOutcome: Equatable, Sendable {
    case saved
    case conflict
    case failed(String)
    case stale
}
