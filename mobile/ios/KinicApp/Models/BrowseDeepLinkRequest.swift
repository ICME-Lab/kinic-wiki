// Where: mobile/ios/KinicApp/Models/BrowseDeepLinkRequest.swift
// What: A normalized browse destination requested by an external or cross-tab link.
// Why: Link receipt must not mutate browse state before unsaved edits are resolved.

import Foundation

struct BrowseDeepLinkRequest: Equatable, Sendable {
    let databaseId: String
    let nodePath: String
}
