// Where: mobile/ios/KinicApp/Services/WorkItemDocument.swift
// What: Versioned VFS document codec for work items.
// Why: An unknown version must be reported, never guessed into a different shape.

import Foundation

/// VFS work-item document contract version 1. See plans/002-ios-shared-work-items.md.
enum WorkItemDocument {
    static let currentVersion = 1

    struct ItemMetadata: Codable, Equatable, Sendable {
        var version: Int
        var captureId: String
        var title: String
        var state: String
        var createdBy: String
        var createdAt: Int64
        var source: WorkItemSource?
    }

    struct ListMetadata: Codable, Equatable, Sendable {
        var version: Int
        var title: String
        var state: String
        var commentCount: Int
        var lastActivityAt: Int64
    }

    struct CommentMetadata: Codable, Equatable, Sendable {
        var version: Int
        var author: String
        var createdAt: Int64
    }

    struct CommentDocument: Equatable, Sendable {
        var metadata: CommentMetadata
        var body: String
    }

    enum Load<Value: Equatable & Sendable>: Equatable, Sendable {
        case loaded(Value)
        case unsupportedVersion(Int)
        case malformed
    }

    static func encode<T: Encodable>(_ value: T) throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(value)
        guard let json = String(data: data, encoding: .utf8) else {
            throw WorkItemDocumentError.notUTF8
        }
        return json
    }

    static func decode<T: Decodable & Sendable>(_ type: T.Type, from metadataJson: String) -> Load<T> {
        guard let data = metadataJson.data(using: .utf8),
              let probe = try? JSONDecoder().decode(VersionProbe.self, from: data) else {
            return .malformed
        }
        guard probe.version == currentVersion else {
            return .unsupportedVersion(probe.version)
        }
        guard let value = try? JSONDecoder().decode(T.self, from: data) else {
            return .malformed
        }
        return .loaded(value)
    }

    static func item(from node: VFSNode) -> Load<WorkItem> {
        switch decode(ItemMetadata.self, from: node.metadataJson) {
        case .unsupportedVersion(let version):
            return .unsupportedVersion(version)
        case .malformed:
            return .malformed
        case .loaded(let metadata):
            guard let itemId = WorkItemPaths.itemId(fromPath: node.path) else {
                return .malformed
            }
            return .loaded(
                WorkItem(
                    id: itemId,
                    captureId: metadata.captureId,
                    title: metadata.title,
                    state: WorkItemState(rawValue: metadata.state) ?? .open,
                    body: node.content,
                    createdBy: metadata.createdBy,
                    createdAt: metadata.createdAt,
                    updatedAt: node.updatedAt,
                    etag: node.etag,
                    source: metadata.source
                )
            )
        }
    }

    static func listEntry(from node: VFSNode) -> Load<WorkItemListEntry> {
        switch decode(ListMetadata.self, from: node.metadataJson) {
        case .unsupportedVersion(let version):
            return .unsupportedVersion(version)
        case .malformed:
            return .malformed
        case .loaded(let metadata):
            guard let itemId = WorkItemPaths.itemId(fromPath: node.path) else {
                return .malformed
            }
            return .loaded(
                WorkItemListEntry(
                    id: itemId,
                    title: metadata.title,
                    state: WorkItemState(rawValue: metadata.state) ?? .open,
                    commentCount: metadata.commentCount,
                    updatedAt: metadata.lastActivityAt,
                    isUnsupportedVersion: false
                )
            )
        }
    }

    static func comment(from node: VFSNode) -> Load<CommentDocument> {
        switch decode(CommentMetadata.self, from: node.metadataJson) {
        case .unsupportedVersion(let version):
            return .unsupportedVersion(version)
        case .malformed:
            return .malformed
        case .loaded(let metadata):
            return .loaded(CommentDocument(metadata: metadata, body: node.content))
        }
    }

    /// Projects the authoritative `item.md` into the list cache document.
    static func listMetadata(for item: WorkItem, commentCount: Int, lastActivityAt: Int64) -> ListMetadata {
        ListMetadata(
            version: currentVersion,
            title: item.title,
            state: item.state.rawValue,
            commentCount: commentCount,
            lastActivityAt: lastActivityAt
        )
    }

    static func entry(from item: WorkItem, commentCount: Int, lastActivityAt: Int64) -> WorkItemListEntry {
        WorkItemListEntry(
            id: item.id,
            title: item.title,
            state: item.state,
            commentCount: commentCount,
            updatedAt: lastActivityAt,
            isUnsupportedVersion: false
        )
    }

    private struct VersionProbe: Decodable {
        var version: Int
    }
}

enum WorkItemDocumentError: Error, LocalizedError, Equatable {
    case notUTF8

    var errorDescription: String? {
        switch self {
        case .notUTF8: "Work item metadata could not be encoded as UTF-8."
        }
    }
}
