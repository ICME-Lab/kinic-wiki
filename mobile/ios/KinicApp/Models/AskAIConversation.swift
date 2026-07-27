// Where: mobile/ios/KinicApp/Models/AskAIConversation.swift
// What: One DB-pinned Ask AI conversation stored on device.
// Why: A conversation must never silently combine evidence from different databases.

import Foundation

struct AskAIConversation: Codable, Identifiable, Equatable, Sendable {
    let id: UUID
    let databaseId: String
    var databaseTitle: String
    var title: String
    var messages: [AskAIMessage]
    let createdAt: Date
    var updatedAt: Date

    init(
        id: UUID = UUID(),
        databaseId: String,
        databaseTitle: String,
        title: String = "New conversation",
        messages: [AskAIMessage] = [],
        createdAt: Date = .now,
        updatedAt: Date = .now
    ) {
        self.id = id
        self.databaseId = databaseId
        self.databaseTitle = databaseTitle
        self.title = title
        self.messages = messages
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}
