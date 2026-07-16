// Where: mobile/ios/KinicTests/BrowseNodeSortOrderTests.swift
// What: Browse child ordering regression tests.
// Why: User-selected sorting must remain stable across folders, missing dates, and ties.

import Testing
@testable import Kinic

struct BrowseNodeSortOrderTests {
    @Test
    func sortsByNameWhileKeepingFoldersFirst() {
        let nodes = [
            child("Zulu.md", kind: .file, updatedAt: 30),
            child("Beta", kind: .folder, updatedAt: 10),
            child("Alpha.md", kind: .file, updatedAt: 20),
            child("Alpha", kind: .folder, updatedAt: 40)
        ]

        #expect(BrowseNodeSortOrder.name.sorted(nodes).map(\.name) == [
            "Alpha", "Beta", "Alpha.md", "Zulu.md"
        ])
    }

    @Test
    func sortsNewestUpdatesFirstWithinEachNodeKind() {
        let nodes = [
            child("Undated.md", kind: .file, updatedAt: nil),
            child("Older.md", kind: .file, updatedAt: 20),
            child("Recent.md", kind: .file, updatedAt: 30),
            child("Older Folder", kind: .folder, updatedAt: 10),
            child("Recent Folder", kind: .folder, updatedAt: 40)
        ]

        #expect(BrowseNodeSortOrder.dateModified.sorted(nodes).map(\.name) == [
            "Recent Folder", "Older Folder", "Recent.md", "Older.md", "Undated.md"
        ])
    }

    @Test
    func breaksMatchingDatesByName() {
        let nodes = [
            child("Zulu.md", kind: .file, updatedAt: 30),
            child("Alpha.md", kind: .file, updatedAt: 30)
        ]

        #expect(BrowseNodeSortOrder.dateModified.sorted(nodes).map(\.name) == ["Alpha.md", "Zulu.md"])
    }
}

private func child(_ name: String, kind: VFSNodeKind, updatedAt: Int64?) -> ChildNode {
    ChildNode(
        path: "/Knowledge/\(name)",
        name: name,
        kind: kind,
        updatedAt: updatedAt,
        etag: nil,
        sizeBytes: nil,
        hasChildren: true,
        isVirtual: false
    )
}
