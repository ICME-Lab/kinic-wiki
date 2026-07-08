// Where: mobile/ios/KinicApp/Models/DatabaseRole.swift
// What: Writable-role model decoded from the VFS canister.
// Why: The app must only offer databases that can accept source capture writes.

import Foundation

enum DatabaseRole: String, CaseIterable, Codable, Equatable, Sendable {
    case owner
    case writer
    case reader

    var canWrite: Bool {
        self == .owner || self == .writer
    }

    var canManageDatabase: Bool {
        self == .owner
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

    var candidName: String {
        switch self {
        case .owner:
            "Owner"
        case .writer:
            "Writer"
        case .reader:
            "Reader"
        }
    }

    var sortRank: Int {
        switch self {
        case .owner:
            0
        case .writer:
            1
        case .reader:
            2
        }
    }
}
