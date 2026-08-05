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
    case publish
    case unpublish
    case delete
}
