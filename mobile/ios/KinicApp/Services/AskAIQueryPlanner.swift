// Where: mobile/ios/KinicApp/Services/AskAIQueryPlanner.swift
// What: Parses a bounded model search plan and appends one safe deterministic fallback anchor.
// Why: Retrieval needs one extra wording fallback without discarding model queries or inventing facts.

import Foundation

enum AskAIQueryPlanner {
    static let maximumGeneratedQueries = 3
    static let maximumQueries = 4
    static let maximumTermsPerQuery = 8
    static let maximumQuestionCharacters = 2_000
    static let maximumHistoryCharacters = 6_000

    static func buildRecoveryPrompt(
        databaseTitle: String,
        question: String,
        history: [AskAIMessage],
        previousPlan: AskAIQueryPlan
    ) -> String {
        let recentHistory = AskAIHistoryFormatter.format(
            history,
            maximumCharacters: maximumHistoryCharacters
        )
        let previousQueries = previousPlan.queries.map(\.text).joined(separator: "\n")
        let boundedQuestion = question.boundedAskAIQueryText(to: maximumQuestionCharacters)

        return """
        SEARCH QUERY RECOVERY
        The first search found no verified note. Produce exactly 3 new query lines that are materially different from every PREVIOUS QUERY.

        Use RECENT CONVERSATION only to resolve a pronoun, definite reference, or omitted topic. When it identifies a distinctive product, person, title, or identifier such as pre-design-md, preserve that exact anchor in the new queries. Do not treat an earlier assistant answer as evidence.

        Keep identifiers and proper nouns exact. Replace descriptive concepts with wording likely to occur in the source, or shorten around the resolved anchor. Never invent a person, product, identifier, or factual claim. Do not repeat a previous query, including a query changed only by case or term order. Each line must contain 1 to 8 space-separated terms.

        Return exactly this structure with no text outside it:
        <answer>first new query
        second new query
        third new query</answer>

        Database: \(databaseTitle.isEmpty ? "(none selected)" : databaseTitle)
        RECENT CONVERSATION:
        \(recentHistory.isEmpty ? "(none)" : recentHistory)

        CURRENT QUESTION:
        \(boundedQuestion)

        PREVIOUS QUERIES:
        \(previousQueries)
        """
    }

    static func parseRecovery(
        _ response: String,
        excluding previousPlan: AskAIQueryPlan
    ) throws -> AskAIQueryPlan {
        let parsed = try parse(response)
        let excluded = Set(previousPlan.queries.map { normalizedQuery($0.text) })
        let queries = parsed.queries.filter { !excluded.contains(normalizedQuery($0.text)) }
        guard !queries.isEmpty else { throw AskAIQueryPlanError.invalidFormat }
        return AskAIQueryPlan(queries: queries)
    }

    static func enriched(
        _ plan: AskAIQueryPlan,
        question: String,
        history: [AskAIMessage]
    ) -> AskAIQueryPlan {
        guard let anchor = contextualAnchor(question: question, history: history) else { return plan }
        let normalizedAnchor = normalizedQuery(anchor.text)
        guard !plan.queries.contains(where: { normalizedQuery($0.text) == normalizedAnchor }) else {
            return plan
        }

        var queries = plan.queries
        if queries.count >= maximumQueries {
            queries.removeLast()
        }
        queries.append(anchor)
        return AskAIQueryPlan(queries: queries)
    }

    static func contextualAnchor(
        question: String,
        history: [AskAIMessage]
    ) -> AskAIQueryPlan.Query? {
        if let identifier = distinctiveASCIIAnchor(in: question) {
            return identifier
        }
        if let katakana = distinctiveKatakanaAnchor(in: question) {
            return .init(text: katakana, terms: [katakana])
        }
        for message in history.reversed() where message.role == .user {
            if let identifier = distinctiveASCIIAnchor(in: message.text) {
                return identifier
            }
        }
        return nil
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
              lines.count <= maximumGeneratedQueries,
              lines.allSatisfy({ !$0.trimmingCharacters(in: .whitespaces).isEmpty }) else {
            throw AskAIQueryPlanError.invalidFormat
        }

        var queries: [AskAIQueryPlan.Query] = []
        var seen: Set<String> = []
        for line in lines {
            let normalized = normalizedQuery(line)
            guard !normalized.isEmpty,
                  !normalized.contains("```"),
                  !normalized.contains("<"),
                  !normalized.contains(">"),
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
        if queries.count < maximumQueries,
           let literal = queries.first,
           let fallback = fallbackAnchor(from: literal),
           seen.insert(fallback.text).inserted {
            queries.append(fallback)
        }
        return AskAIQueryPlan(queries: queries)
    }

    static func normalizedQuery(_ value: String) -> String {
        value
            .precomposedStringWithCompatibilityMapping
            .lowercased(with: Locale(identifier: "en_US_POSIX"))
            .trimmingCharacters(in: .whitespaces)
    }

    private static func fallbackAnchor(
        from literal: AskAIQueryPlan.Query
    ) -> AskAIQueryPlan.Query? {
        guard literal.terms.count > 1, let firstTerm = literal.terms.first else { return nil }
        if let splitVersion = splitTrailingVersion(firstTerm) {
            return .init(text: splitVersion.joined(separator: " "), terms: splitVersion)
        }
        let scalarCount = firstTerm.unicodeScalars.count
        let containsNonASCII = firstTerm.unicodeScalars.contains { !$0.isASCII }
        let isDistinctiveASCII = firstTerm.unicodeScalars.allSatisfy { $0.isASCII }
            && (scalarCount >= 4 || firstTerm.contains(where: \.isNumber))
        guard (containsNonASCII && scalarCount >= 3) || isDistinctiveASCII else { return nil }
        return .init(text: firstTerm, terms: [firstTerm])
    }

    private static func splitTrailingVersion(_ term: String) -> [String]? {
        let characters = Array(term)
        guard let digitStart = characters.firstIndex(where: \.isNumber),
              digitStart >= 3,
              (1...2).contains(characters.count - digitStart),
              characters[..<digitStart].allSatisfy({ $0.isASCII && $0.isLetter }),
              characters[digitStart...].allSatisfy({ $0.isASCII && $0.isNumber }) else {
            return nil
        }
        return [String(characters[..<digitStart]), String(characters[digitStart...])]
    }

    private static func isNumberedBullet(_ value: String) -> Bool {
        let remainder = value.drop(while: \.isNumber)
        return remainder.count < value.count && (remainder.first == "." || remainder.first == ")")
    }

    private static func distinctiveASCIIAnchor(in value: String) -> AskAIQueryPlan.Query? {
        var rawTerms: [String] = []
        var current = ""
        for scalar in value.unicodeScalars {
            if scalar.isASCII,
               CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_")).contains(scalar) {
                current.unicodeScalars.append(scalar)
            } else if !current.isEmpty {
                rawTerms.append(current)
                current = ""
            }
        }
        if !current.isEmpty { rawTerms.append(current) }
        let generic = Set(["which", "what", "where", "when", "article", "tool", "design", "harness"])

        for (index, rawTerm) in rawTerms.enumerated() {
            let term = normalizedQuery(rawTerm)
            guard term.unicodeScalars.allSatisfy(\.isASCII),
                  term.count >= 4,
                  (term.contains("-")
                    || term.contains("_")
                    || term.contains(where: \.isNumber)
                    || term == "predesign"),
                  !generic.contains(term) else { continue }
            if index + 1 < rawTerms.count {
                let next = normalizedQuery(rawTerms[index + 1])
                if next.count >= 2,
                   next.count <= 3,
                   next.unicodeScalars.allSatisfy(\.isASCII) {
                    return .init(text: "\(term) \(next)", terms: [term, next])
                }
            }
            return .init(text: term, terms: [term])
        }
        return nil
    }

    private static func distinctiveKatakanaAnchor(in value: String) -> String? {
        var runs: [String] = []
        var current = ""
        for scalar in value.unicodeScalars {
            if (0x30A0...0x30FF).contains(scalar.value) || scalar.value == 0x30FC {
                current.unicodeScalars.append(scalar)
            } else if !current.isEmpty {
                runs.append(current)
                current = ""
            }
        }
        if !current.isEmpty { runs.append(current) }
        let generic = Set(["ツール", "デザイン", "デザインツール", "ノート", "データベース"])
        return runs.first { $0.count >= 3 && !generic.contains($0) }
    }
}

private extension String {
    func boundedAskAIQueryText(to limit: Int) -> String {
        guard count > limit else { return self }
        return String(prefix(limit))
    }
}

enum AskAIQueryPlanError: Error, LocalizedError, Equatable {
    case invalidFormat

    var errorDescription: String? {
        "Kinic AI could not produce a valid search query."
    }
}
