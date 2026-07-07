// Where: mobile/ios/KinicApp/Models/DatabaseRole.swift
// What: Writable-role model decoded from the VFS canister.
// Why: The app must only offer databases that can accept source capture writes.

import Foundation

enum DatabaseRole: String, Equatable, Sendable {
    case owner
    case writer
    case reader

    var canWrite: Bool {
        self == .owner || self == .writer
    }

    var displayName: String {
        switch self {
        case .owner:
            "Owner"
        case .writer:
            "Writer"
        case .reader:
            "Reader"
        }
    }
}
