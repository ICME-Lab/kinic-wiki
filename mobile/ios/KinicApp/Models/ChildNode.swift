// Where: mobile/ios/KinicApp/Models/ChildNode.swift
// What: Folder child row returned by the Kinic VFS canister.
// Why: The native browser needs a compact tree entry without loading full node content.

import Foundation

struct ChildNode: Identifiable, Equatable, Sendable {
    let path: String
    let name: String
    let kind: VFSNodeKind
    let updatedAt: Int64?
    let etag: String?
    let sizeBytes: UInt64?
    let hasChildren: Bool
    let isVirtual: Bool

    var id: String {
        path
    }
}
