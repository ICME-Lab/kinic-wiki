// Where: mobile/ios/KinicApp/Models/AskAIMessage.swift
// What: A persisted user question or grounded assistant response.
// Why: Ask AI conversations need durable, testable state independent of SwiftUI views.

import Foundation

struct AskAIMessage: Codable, Identifiable, Equatable, Sendable {
    let id: UUID
    let role: AskAIMessageRole
    var text: String
    var state: AskAIMessageState
    var sources: [AskAISource]
    var trace: [AskAITraceEvent]
    let createdAt: Date

    init(
        id: UUID = UUID(),
        role: AskAIMessageRole,
        text: String,
        state: AskAIMessageState = .complete,
        sources: [AskAISource] = [],
        trace: [AskAITraceEvent] = [],
        createdAt: Date = .now
    ) {
        self.id = id
        self.role = role
        self.text = text
        self.state = state
        self.sources = sources
        self.trace = trace
        self.createdAt = createdAt
    }
}
