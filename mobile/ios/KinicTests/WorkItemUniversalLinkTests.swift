// Where: mobile/ios/KinicTests/WorkItemUniversalLinkTests.swift
// What: Contract tests for the work item universal links the widget opens.
// Why: A widget tap must reach exactly one destination and never be silently dropped.

import Foundation
import Testing
@testable import Kinic

struct WorkItemUniversalLinkTests {
    @Test
    func buildsTheItemAndComposeLinks() throws {
        let item = try #require(WorkItemUniversalLink.item(databaseId: "db-1", itemId: "item-1"))
        #expect(item.absoluteString == "https://wiki.kinic.xyz/ios-work-item?databaseId=db-1&itemId=item-1")

        let compose = try #require(WorkItemUniversalLink.compose(databaseId: "db-1"))
        #expect(compose.absoluteString == "https://wiki.kinic.xyz/ios-work-items?compose=1&databaseId=db-1")

        let composeWithoutDatabase = try #require(WorkItemUniversalLink.compose(databaseId: nil))
        #expect(composeWithoutDatabase.absoluteString == "https://wiki.kinic.xyz/ios-work-items?compose=1")
    }

    @Test
    func parsesTheItemAndComposeLinks() throws {
        let item = try #require(WorkItemUniversalLink.item(databaseId: "db 1", itemId: "ITEM-2"))
        #expect(
            WorkItemUniversalLink.destination(for: item, callbackDomain: "wiki.kinic.xyz")
                == .item(databaseId: "db 1", itemId: "ITEM-2")
        )

        let compose = try #require(WorkItemUniversalLink.compose(databaseId: "db-1"))
        #expect(
            WorkItemUniversalLink.destination(for: compose, callbackDomain: "wiki.kinic.xyz")
                == .compose(databaseId: "db-1")
        )

        let composeWithoutDatabase = try #require(WorkItemUniversalLink.compose(databaseId: nil))
        #expect(
            WorkItemUniversalLink.destination(for: composeWithoutDatabase, callbackDomain: "wiki.kinic.xyz")
                == .compose(databaseId: nil)
        )
    }

    @Test
    func rejectsLinksThatAreNotCompleteWorkItemEntryPoints() {
        // A foreign host must never be treated as an app entry point.
        #expect(
            WorkItemUniversalLink.destination(
                for: URL(string: "https://evil.example/ios-work-item?databaseId=db&itemId=item")!,
                callbackDomain: "wiki.kinic.xyz"
            ) == nil
        )
        // An item link without both identifiers has no destination.
        #expect(
            WorkItemUniversalLink.destination(
                for: URL(string: "https://wiki.kinic.xyz/ios-work-item?databaseId=db")!,
                callbackDomain: "wiki.kinic.xyz"
            ) == nil
        )
        // The wiki browse path is not a work item link.
        #expect(
            WorkItemUniversalLink.destination(
                for: URL(string: "https://wiki.kinic.xyz/db/db-1/Knowledge/Page.md")!,
                callbackDomain: "wiki.kinic.xyz"
            ) == nil
        )
    }

    @Test
    func classifiesWorkItemLinksThroughTheAppRouter() {
        #expect(
            AppModel.openURLDestination(
                for: URL(string: "https://wiki.kinic.xyz/ios-work-item?databaseId=db-1&itemId=item-1")!,
                callbackDomain: "wiki.kinic.xyz"
            ) == .workItem(databaseId: "db-1", itemId: "item-1")
        )
        #expect(
            AppModel.openURLDestination(
                for: URL(string: "https://wiki.kinic.xyz/ios-work-items?compose=1&databaseId=db-1")!,
                callbackDomain: "wiki.kinic.xyz"
            ) == .workItemsCompose(databaseId: "db-1")
        )
        #expect(
            AppModel.openURLDestination(
                for: URL(string: "https://wiki.kinic.xyz/ios-work-items")!,
                callbackDomain: "wiki.kinic.xyz"
            ) == .workItemsCompose(databaseId: "")
        )
        // An incomplete link is reported to the member instead of being ignored.
        #expect(
            AppModel.openURLDestination(
                for: URL(string: "https://wiki.kinic.xyz/ios-work-item?databaseId=db-1")!,
                callbackDomain: "wiki.kinic.xyz"
            ) == .home("This work item link is incomplete.")
        )
    }

    @Test
    func truncatesLongSourceDocumentsAtTheComposerLimit() {
        let short = String(repeating: "a", count: WorkItemComposeRequest.bodyCharacterLimit)
        let long = short + "b"

        #expect(WorkItemComposeRequest.truncatedBody(short).isTruncated == false)
        let truncated = WorkItemComposeRequest.truncatedBody(long)
        #expect(truncated.isTruncated)
        #expect(truncated.body.count == WorkItemComposeRequest.bodyCharacterLimit)
    }
}
