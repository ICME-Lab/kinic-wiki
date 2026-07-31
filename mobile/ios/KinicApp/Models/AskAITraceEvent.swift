// Where: mobile/ios/KinicApp/Models/AskAITraceEvent.swift
// What: One completed or active step in the Ask AI retrieval trace.
// Why: Search progress should be inspectable and persistable without storing full source documents.

import Foundation

struct AskAITraceEvent: Codable, Identifiable, Equatable, Sendable {
    let id: UUID
    let stage: AskAITraceStage
    let title: String
    let detail: String?
    var isActive: Bool

    init(
        id: UUID = UUID(),
        stage: AskAITraceStage,
        title: String,
        detail: String? = nil,
        isActive: Bool = false
    ) {
        self.id = id
        self.stage = stage
        self.title = title
        self.detail = detail
        self.isActive = isActive
    }
}
