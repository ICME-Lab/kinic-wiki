// Where: mobile/ios/KinicApp/Services/AskAIResponseOutcome.swift
// What: Validated grounding outcome from the chat response protocol.
// Why: Unsupported content must be suppressed before it reaches persisted UI state.

import Foundation

enum AskAIResponseOutcome: Equatable, Sendable {
    case supported(sourceIDs: [String], answer: String)
    case insufficient
}
