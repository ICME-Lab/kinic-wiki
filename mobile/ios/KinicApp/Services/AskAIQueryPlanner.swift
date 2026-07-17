// Where: mobile/ios/KinicApp/Services/AskAIQueryPlanner.swift
// What: Builds the query-rewrite prompt and strictly parses its tagged result.
// Why: Every Ask AI retrieval starts from an AI-produced, bounded search plan with no local fallback.

import Foundation

enum AskAIQueryPlanner {
    static let maximumQueries = 3
    static let maximumTermsPerQuery = 4
    static let maximumQuestionCharacters = 2_000
    static let maximumHistoryCharacters = 6_000

    static func buildPrompt(
        databaseTitle: String,
        question: String,
        history: [AskAIMessage]
    ) -> String {
        let recentHistory = history.suffix(6)
            .map { message in
                "\(message.role == .user ? "USER" : "ASSISTANT"): \(message.text)"
            }
            .joined(separator: "\n")
            .boundedAskAIText(to: maximumHistoryCharacters)
        let boundedQuestion = question.boundedAskAIText(to: maximumQuestionCharacters)

        return """
        SEARCH QUERY REWRITER
        Output one leading blank line before the opening tag. Then output the literal tag <answer>, the query lines, and the literal tag </answer>. The leading blank line is required so <answer> is not the first generated token. A response without both literal tags is invalid.

        Write 1 to 3 search-query lines between those tags. Each line must have 1 to 4 space-separated terms; prefer 2 or 3 terms. Preserve identifiers, proper nouns, and key nouns from CURRENT QUESTION exactly. Never replace a noun with a related noun. An optional English variant must be a separate line and must still have at most 4 terms.

        Forbidden: answering the question, Markdown fences, backticks, XML declarations, bullets, numbering, quotes, explanations, blank query lines, more than 3 query lines, more than 4 terms per line, or the database name as a search term.

        Use RECENT CONVERSATION only to resolve a pronoun or omitted subject in CURRENT QUESTION. Never copy an unrelated earlier topic. Before responding, silently count the query lines and terms and shorten any line that exceeds the limits.

        Database: \(databaseTitle)
        RECENT CONVERSATION:
        \(recentHistory.isEmpty ? "(none)" : recentHistory)

        CURRENT QUESTION:
        \(boundedQuestion)

        Return only this literal structure, including one blank line before <answer> and replacing QUERY LINES with queries:

        <answer>
        QUERY LINES
        </answer>
        """
    }

    static func parse(_ response: String) throws -> AskAIQueryPlan {
        guard !response.unicodeScalars.contains(where: { scalar in
            CharacterSet.controlCharacters.contains(scalar) && scalar != "\n" && scalar != "\r"
        }) else {
            throw AskAIQueryPlanError.invalidFormat
        }
        guard response.components(separatedBy: "<answer>").count == 2,
              response.components(separatedBy: "</answer>").count == 2,
              let openingRange = response.range(of: "<answer>"),
              let closingRange = response.range(of: "</answer>"),
              openingRange.upperBound <= closingRange.lowerBound,
              response[..<openingRange.lowerBound].allSatisfy(\Character.isWhitespace),
              response[closingRange.upperBound...].allSatisfy(\Character.isWhitespace) else {
            throw AskAIQueryPlanError.invalidFormat
        }

        let body = String(response[openingRange.upperBound..<closingRange.lowerBound])
            .replacing("\r\n", with: "\n")
            .replacing("\r", with: "\n")
        let rawLines = body.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        let lines = rawLines.drop(while: { $0.trimmingCharacters(in: .whitespaces).isEmpty })
            .reversed()
            .drop(while: { $0.trimmingCharacters(in: .whitespaces).isEmpty })
            .reversed()
        guard !lines.isEmpty,
              lines.count <= maximumQueries,
              lines.allSatisfy({ !$0.trimmingCharacters(in: .whitespaces).isEmpty }) else {
            throw AskAIQueryPlanError.invalidFormat
        }

        var queries: [AskAIQueryPlan.Query] = []
        var seen: Set<String> = []
        for line in lines {
            let normalized = line
                .precomposedStringWithCompatibilityMapping
                .lowercased(with: Locale(identifier: "en_US_POSIX"))
                .trimmingCharacters(in: .whitespaces)
            guard !normalized.isEmpty,
                  !normalized.contains("```"),
                  !normalized.hasPrefix("-"),
                  !normalized.hasPrefix("*"),
                  !isNumberedBullet(normalized) else {
                throw AskAIQueryPlanError.invalidFormat
            }
            let terms = normalized.split(whereSeparator: \Character.isWhitespace).map(String.init)
            guard (1...maximumTermsPerQuery).contains(terms.count) else {
                throw AskAIQueryPlanError.invalidFormat
            }
            if seen.insert(normalized).inserted {
                queries.append(.init(text: normalized, terms: terms))
            }
        }
        guard !queries.isEmpty else {
            throw AskAIQueryPlanError.invalidFormat
        }
        return AskAIQueryPlan(queries: queries)
    }

    private static func isNumberedBullet(_ value: String) -> Bool {
        let remainder = value.drop(while: \.isNumber)
        return remainder.count < value.count && (remainder.first == "." || remainder.first == ")")
    }
}

enum AskAIQueryPlanError: Error, LocalizedError, Equatable {
    case invalidFormat

    var errorDescription: String? {
        "Kinic AI could not produce a valid search query."
    }
}

extension String {
    fileprivate func boundedAskAIText(to limit: Int) -> String {
        guard count > limit else { return self }
        return String(prefix(limit))
    }
}
