// Where: mobile/ios/KinicApp/Models/AskAIMessageRole.swift
// What: Persisted speaker identity for an Ask AI message.
// Why: Conversation rendering and prompt history must agree on message ownership.

import Foundation

enum AskAIMessageRole: String, Codable, Sendable {
    case user
    case assistant
}
