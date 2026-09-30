// Where: mobile/ios/KinicTests/WorkItemDocumentTests.swift
// What: Contract tests for the versioned work item VFS documents.
// Why: An unknown document version must be reported, never reinterpreted as version 1.

import Foundation
import Testing
@testable import Kinic

struct WorkItemDocumentTests {
    private func node(
        path: String,
        content: String,
        metadataJson: String,
        etag: String = "etag-1",
        updatedAt: Int64 = 1_700_000_000_000
    ) -> VFSNode {
        VFSNode(
            path: path,
            kind: .file,
            content: content,
            metadataJson: metadataJson,
            etag: etag,
            createdAt: updatedAt,
            updatedAt: updatedAt
        )
    }

    @Test
    func itemMetadataRoundTrips() throws {
        let metadata = WorkItemDocument.ItemMetadata(
            version: 1,
            captureId: "capture-1",
            title: "Fix the roof",
            state: "open",
            createdBy: "2vxsx-fae",
            createdAt: 1_700_000_000_000,
            source: WorkItemSource(kind: .share, url: "https://example.com/a", path: nil, label: "Example")
        )
        let json = try WorkItemDocument.encode(metadata)
        #expect(WorkItemDocument.decode(WorkItemDocument.ItemMetadata.self, from: json) == .loaded(metadata))
    }

    @Test
    func unknownVersionIsReportedInsteadOfDecoded() {
        let json = #"{"version":2,"captureId":"c","title":"t","state":"open","createdBy":"p","createdAt":1}"#
        #expect(WorkItemDocument.decode(WorkItemDocument.ItemMetadata.self, from: json) == .unsupportedVersion(2))
    }

    @Test
    func malformedMetadataIsReported() {
        #expect(WorkItemDocument.decode(WorkItemDocument.ItemMetadata.self, from: "not json") == .malformed)
        #expect(WorkItemDocument.decode(WorkItemDocument.ItemMetadata.self, from: #"{"title":"t"}"#) == .malformed)
    }

    @Test
    func itemBuildsFromTheItemPath() throws {
        let metadata = WorkItemDocument.ItemMetadata(
            version: 1,
            captureId: "capture-1",
            title: "Fix the roof",
            state: "closed",
            createdBy: "2vxsx-fae",
            createdAt: 10,
            source: nil
        )
        let json = try WorkItemDocument.encode(metadata)
        let loaded = WorkItemDocument.item(
            from: node(path: "/WorkItems/abc-123/item.md", content: "Body", metadataJson: json, etag: "etag-9")
        )
        guard case .loaded(let item) = loaded else {
            Issue.record("expected a loaded item, got \(loaded)")
            return
        }
        #expect(item.id == "abc-123")
        #expect(item.captureId == "capture-1")
        #expect(item.state == .closed)
        #expect(item.body == "Body")
        #expect(item.etag == "etag-9")
    }

    @Test
    func listEntryCarriesTheProjectedCounters() throws {
        let metadata = WorkItemDocument.ListMetadata(
            version: 1,
            title: "Fix the roof",
            state: "open",
            commentCount: 3,
            lastActivityAt: 42
        )
        let json = try WorkItemDocument.encode(metadata)
        let loaded = WorkItemDocument.listEntry(
            from: node(path: "/WorkItems/abc-123/meta.md", content: "", metadataJson: json)
        )
        #expect(loaded == .loaded(WorkItemListEntry(id: "abc-123", title: "Fix the roof", state: .open, commentCount: 3, updatedAt: 42, isUnsupportedVersion: false)))
    }

    @Test
    func commentDocumentDecodesWithItsAuthor() throws {
        let metadata = WorkItemDocument.CommentMetadata(version: 1, author: "2vxsx-fae", createdAt: 7)
        let json = try WorkItemDocument.encode(metadata)
        let loaded = WorkItemDocument.comment(
            from: node(path: "/WorkItems/abc/comments/c1.md", content: "Looks good", metadataJson: json)
        )
        guard case .loaded(let comment) = loaded else {
            Issue.record("expected a loaded comment, got \(loaded)")
            return
        }
        #expect(comment.body == "Looks good")
        #expect(comment.metadata.author == "2vxsx-fae")
        #expect(comment.metadata.createdAt == 7)
    }

    @Test
    func pathsStayInsideTheWorkItemsRoot() {
        #expect(WorkItemPaths.item("abc") == "/WorkItems/abc/item.md")
        #expect(WorkItemPaths.listMetadata("abc") == "/WorkItems/abc/meta.md")
        #expect(WorkItemPaths.comment(itemId: "abc", commentId: "c1") == "/WorkItems/abc/comments/c1.md")
        #expect(WorkItemPaths.itemId(fromPath: "/WorkItems/abc/item.md") == "abc")
        #expect(WorkItemPaths.itemId(fromPath: "/WorkItems/abc/comments/c1.md") == "abc")
        #expect(WorkItemPaths.itemId(fromPath: "/Knowledge/Page.md") == nil)
        #expect(WorkItemPaths.isInsideWorkItems("/WorkItems/abc/meta.md"))
        #expect(!WorkItemPaths.isInsideWorkItems("/WorkItemsOld/abc"))
    }
}
