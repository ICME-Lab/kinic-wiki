// Where: mobile/ios/KinicApp/Models/AskAISource.swift
// What: A bounded, display-safe reference used by an Ask AI response.
// Why: Answers need deterministic links to DB evidence without persisting whole documents.

import Foundation

struct AskAISource: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let path: String
    let excerpt: String
    let score: Float
    let matchReasons: [String]

    var displayName: String {
        path.split(separator: "/").last.map(String.init) ?? path
    }
}
