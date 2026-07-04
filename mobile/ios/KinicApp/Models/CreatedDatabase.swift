// Where: mobile/ios/KinicApp/Models/CreatedDatabase.swift
// What: Result returned by VFS create_database.
// Why: The app needs to select active databases and explain pending databases after creation.

import Foundation

struct CreatedDatabase: Equatable, Sendable {
    let databaseId: String
    let name: String
    let status: DatabaseStatus
    let initialFreeGrantApplied: Bool
}
