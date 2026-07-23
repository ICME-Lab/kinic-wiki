// Where: mobile/ios/KinicApp/Services/AskAIHistoryFormatter.swift
// What: Formats recent Ask AI messages within a newest-first character budget.
// Why: Follow-up prompts must retain the latest turns when older answers are long.

import Foundation

enum AskAIHistoryFormatter {
    static func format(
        _ history: [AskAIMessage],
        maximumMessages: Int = 6,
        maximumCharacters: Int
    ) -> String {
        guard maximumMessages > 0, maximumCharacters > 0 else { return "" }

        let messages = history.suffix(maximumMessages).map { message in
            "\(message.role == .user ? "USER" : "ASSISTANT"): \(message.text)"
        }
        var remainingCharacters = maximumCharacters
        var newestFirst: [String] = []

        for message in messages.reversed() {
            let separatorCharacters = newestFirst.isEmpty ? 0 : 1
            let requiredCharacters = separatorCharacters + message.count
            if requiredCharacters <= remainingCharacters {
                newestFirst.append(message)
                remainingCharacters -= requiredCharacters
            } else if newestFirst.isEmpty {
                newestFirst.append(String(message.prefix(remainingCharacters)))
                remainingCharacters = 0
            } else {
                break
            }
        }

        return newestFirst.reversed().joined(separator: "\n")
    }
}
