// Where: mobile/ios/KinicApp/Models/AskAIContextSource.swift
// What: Transient source content prepared for one grounded AI request.
// Why: Full DB text must stay out of persisted conversation history.

import Foundation

struct AskAIContextSource: Equatable, Sendable {
    let source: AskAISource
    let content: String
}
