// Where: mobile/ios/KinicApp/Models/BrowseNodeSortOrder.swift
// What: User-selectable ordering for child nodes in the native browser.
// Why: Browse folders need predictable name and recent-update views.

import Foundation

enum BrowseNodeSortOrder: String, CaseIterable, Hashable, Identifiable {
    case name
    case dateModified

    var id: Self {
        self
    }

    var title: String {
        switch self {
        case .name:
            "Name"
        case .dateModified:
            "Date Modified"
        }
    }

    var systemImage: String {
        switch self {
        case .name:
            "textformat"
        case .dateModified:
            "clock"
        }
    }

    func sorted(_ nodes: [ChildNode]) -> [ChildNode] {
        nodes.sorted(by: precedes)
    }

    private func precedes(_ left: ChildNode, _ right: ChildNode) -> Bool {
        if left.kind == .folder && right.kind != .folder {
            return true
        }
        if left.kind != .folder && right.kind == .folder {
            return false
        }

        switch self {
        case .name:
            return compareNames(left, right)
        case .dateModified:
            if left.updatedAt != right.updatedAt {
                return (left.updatedAt ?? .min) > (right.updatedAt ?? .min)
            }
            return compareNames(left, right)
        }
    }

    private func compareNames(_ left: ChildNode, _ right: ChildNode) -> Bool {
        let comparison = left.name.localizedCaseInsensitiveCompare(right.name)
        if comparison != .orderedSame {
            return comparison == .orderedAscending
        }
        return left.path < right.path
    }
}
