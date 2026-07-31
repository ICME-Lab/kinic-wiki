// Where: mobile/ios/KinicApp/Models/AskAITraceStage.swift
// What: Verifiable retrieval stages shown in the Ask AI memory trace.
// Why: The UI explains real app work without pretending to expose model reasoning.

import Foundation

enum AskAITraceStage: String, Codable, Sendable {
    case searching
    case found
    case reading
    case verifying
    case generating
}
