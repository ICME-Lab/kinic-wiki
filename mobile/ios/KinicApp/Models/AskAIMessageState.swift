// Where: mobile/ios/KinicApp/Models/AskAIMessageState.swift
// What: User-visible completion state for an Ask AI response.
// Why: Grounding failures must remain distinct from transport failures and valid answers.

import Foundation

enum AskAIMessageState: String, Codable, Sendable {
    case complete
    case generating
    case insufficient
    case failed
}
