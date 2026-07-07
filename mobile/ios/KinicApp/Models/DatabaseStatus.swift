// Where: mobile/ios/KinicApp/Models/DatabaseStatus.swift
// What: Database lifecycle status decoded from the VFS canister.
// Why: Deleted and pending databases should not be used as capture targets.

import Foundation

enum DatabaseStatus: String, Equatable, Sendable {
    case active
    case deleted
    case pending

    var displayName: String {
        switch self {
        case .active:
            "Active"
        case .deleted:
            "Deleted"
        case .pending:
            "Pending"
        }
    }
}
