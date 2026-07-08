// Where: mobile/ios/KinicApp/Views/BrowseFolderRoute.swift
// What: Hashable browse route used by NavigationStack.
// Why: Compact iPhone navigation must push folders and documents through the same value path.

import Foundation

struct BrowseFolderRoute: Hashable {
    enum Kind: Hashable {
        case folder
        case document
    }

    let path: String
    let kind: Kind

    init(path: String, kind: Kind = .folder) {
        self.path = path
        self.kind = kind
    }

    static func document(path: String) -> BrowseFolderRoute {
        BrowseFolderRoute(path: path, kind: .document)
    }
}
