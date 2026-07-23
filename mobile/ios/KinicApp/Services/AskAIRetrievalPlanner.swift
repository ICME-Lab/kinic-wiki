// Where: mobile/ios/KinicApp/Services/AskAIRetrievalPlanner.swift
// What: AI-query candidate aggregation and exact semantic-token verification for Ask AI.
// Why: Broad VFS search retrieves candidates, but only query-majority token matches become answer evidence.

import Foundation
import NaturalLanguage

enum AskAIRetrievalPlanner {
    static let searchLimitPerQuery: UInt32 = 8
    static let maximumSources = 5
    static let maximumContextCharactersPerSource = 3_000

    struct PreparedEvidence: Equatable, Sendable {
        let excerpt: String
        let content: String
    }

    struct Candidate: Equatable, Sendable {
        let hit: SearchNodeHit
        let matchedQueryCount: Int
        let bestScore: Float
    }

    private enum CompoundKind {
        case asciiAlphanumeric
        case katakana
    }

    static func requiredMatchCount(for termCount: Int) -> Int {
        guard termCount > 0 else { return 0 }
        return (termCount / 2) + 1
    }

    static func rankedCandidates(
        queryPlan: AskAIQueryPlan,
        hitsByQuery: [String: [SearchNodeHit]]
    ) -> [Candidate] {
        struct Aggregate {
            var bestHit: SearchNodeHit
            var matchedQueries: Set<String>
            var bestScore: Float
            var matchReasons: Set<String>
        }

        var aggregates: [String: Aggregate] = [:]
        for query in queryPlan.queries {
            var pathsSeenForQuery: Set<String> = []
            for hit in hitsByQuery[query.text, default: []]
            where hit.kind != .folder && pathsSeenForQuery.insert(hit.path).inserted {
                if var aggregate = aggregates[hit.path] {
                    aggregate.matchedQueries.insert(query.text)
                    aggregate.bestScore = min(aggregate.bestScore, hit.score)
                    aggregate.matchReasons.formUnion(hit.matchReasons)
                    if hit.score < aggregate.bestHit.score {
                        aggregate.bestHit = hit
                    }
                    aggregates[hit.path] = aggregate
                } else {
                    aggregates[hit.path] = Aggregate(
                        bestHit: hit,
                        matchedQueries: [query.text],
                        bestScore: hit.score,
                        matchReasons: Set(hit.matchReasons)
                    )
                }
            }
        }

        return aggregates.values
            .map { aggregate in
                let bestHit = aggregate.bestHit
                return Candidate(
                    hit: SearchNodeHit(
                        path: bestHit.path,
                        kind: bestHit.kind,
                        snippet: bestHit.snippet,
                        previewExcerpt: bestHit.previewExcerpt,
                        matchReasons: aggregate.matchReasons.sorted(),
                        score: aggregate.bestScore
                    ),
                    matchedQueryCount: aggregate.matchedQueries.count,
                    bestScore: aggregate.bestScore
                )
            }
            .sorted { left, right in
                if left.matchedQueryCount != right.matchedQueryCount {
                    return left.matchedQueryCount > right.matchedQueryCount
                }
                if left.bestScore != right.bestScore {
                    return left.bestScore < right.bestScore
                }
                return left.hit.path < right.hit.path
            }
    }

    static func hasRequiredExactMatches(
        queryPlan: AskAIQueryPlan,
        path: String,
        content: String
    ) -> Bool {
        let searchableText = normalize("\(path)\n\(content)")
        let searchableTokens = Set(semanticTokens(in: searchableText))
        return queryPlan.queries.contains { query in
            let queryTokens = Set(semanticTokens(in: query.text))
            guard !queryTokens.isEmpty else { return false }
            var matchingTokens = queryTokens.intersection(searchableTokens)
            for segment in normalizedSegments(in: query.text)
            where segment.unicodeScalars.contains(where: { !$0.isASCII }) {
                let segmentTokens = Set(semanticTokens(in: segment))
                guard segmentTokens.count > 1, searchableText.contains(segment) else { continue }
                matchingTokens.formUnion(segmentTokens)
            }
            let matchCount = matchingTokens.count
            return matchCount >= requiredMatchCount(for: queryTokens.count)
        }
    }

    static func prepareEvidence(
        queryPlan: AskAIQueryPlan,
        hit: SearchNodeHit,
        content: String
    ) -> PreparedEvidence {
        let preview = [hit.previewExcerpt, hit.snippet]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first(where: { !$0.isEmpty })
            ?? ""
        let anchor = previewRange(preview, in: content)
            ?? narrowestRequiredQueryRange(queryPlan: queryPlan, in: content)
        let window = contextWindow(in: content, around: anchor)
        let excerpt = preview.isEmpty
            ? String(window.trimmingCharacters(in: .whitespacesAndNewlines).prefix(300))
            : String(preview.prefix(300))
        return PreparedEvidence(excerpt: excerpt, content: window)
    }

    static func semanticTokens(in value: String) -> [String] {
        let normalizedValue = normalize(value)
        guard !normalizedValue.isEmpty else { return [] }

        return normalizedSegments(in: normalizedValue).flatMap(tokenizedSegment)
    }

    private static func normalizedSegments(in value: String) -> [String] {
        normalize(value)
            .split(whereSeparator: { character in
                character.isWhitespace || character.unicodeScalars.allSatisfy { scalar in
                    CharacterSet.punctuationCharacters.contains(scalar)
                        || CharacterSet.symbols.contains(scalar)
                }
            })
            .map(String.init)
    }

    private static func tokenizedSegment(_ segment: String) -> [String] {
        let tokenizer = NLTokenizer(unit: .word)
        tokenizer.string = segment
        tokenizer.setLanguage(.japanese)

        var tokens: [(value: String, range: Range<String.Index>, compoundKind: CompoundKind?)] = []
        tokenizer.enumerateTokens(in: segment.startIndex..<segment.endIndex) { range, _ in
            let token = normalize(String(segment[range]))
            let kind = compoundKind(for: token)
            if let previous = tokens.last,
               previous.range.upperBound == range.lowerBound,
               let kind,
               previous.compoundKind == kind {
                tokens[tokens.count - 1] = (
                    previous.value + token,
                    previous.range.lowerBound..<range.upperBound,
                    kind
                )
            } else if !token.isEmpty {
                tokens.append((token, range, kind))
            }
            return true
        }
        return tokens.map(\.value)
    }

    private static func normalize(_ value: String) -> String {
        value
            .precomposedStringWithCompatibilityMapping
            .lowercased(with: Locale(identifier: "en_US_POSIX"))
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func previewRange(_ preview: String, in content: String) -> Range<String.Index>? {
        guard !preview.isEmpty else { return nil }
        return content.range(of: preview, options: evidenceSearchOptions)
    }

    private static func narrowestRequiredQueryRange(
        queryPlan: AskAIQueryPlan,
        in content: String
    ) -> Range<String.Index>? {
        var bestRange: Range<String.Index>?
        var bestLength: Int?

        for query in queryPlan.queries {
            let tokens = Array(Set(semanticTokens(in: query.text)))
            let requiredCount = requiredMatchCount(for: tokens.count)
            guard requiredCount > 0 else { continue }

            var occurrences: [(range: Range<String.Index>, token: String)] = []
            for token in tokens {
                occurrences.append(contentsOf: ranges(of: token, in: content).map { ($0, token) })
            }
            occurrences.sort { left, right in
                if left.range.lowerBound != right.range.lowerBound {
                    return left.range.lowerBound < right.range.lowerBound
                }
                return left.range.upperBound < right.range.upperBound
            }

            var left = 0
            var tokenCounts: [String: Int] = [:]
            for right in occurrences.indices {
                tokenCounts[occurrences[right].token, default: 0] += 1
                while left <= right, tokenCounts.count >= requiredCount {
                    let candidate = occurrences[left].range.lowerBound..<occurrences[right].range.upperBound
                    let length = content.distance(from: candidate.lowerBound, to: candidate.upperBound)
                    if bestLength.map({ length < $0 }) ?? true {
                        bestRange = candidate
                        bestLength = length
                    }
                    let leftToken = occurrences[left].token
                    if tokenCounts[leftToken] == 1 {
                        tokenCounts.removeValue(forKey: leftToken)
                    } else {
                        tokenCounts[leftToken, default: 0] -= 1
                    }
                    left += 1
                }
            }
        }
        return bestRange
    }

    private static func ranges(of value: String, in content: String) -> [Range<String.Index>] {
        guard !value.isEmpty else { return [] }
        var results: [Range<String.Index>] = []
        var searchStart = content.startIndex
        while searchStart < content.endIndex,
              let range = content.range(
                  of: value,
                  options: evidenceSearchOptions,
                  range: searchStart..<content.endIndex
              ) {
            results.append(range)
            searchStart = range.upperBound
        }
        return results
    }

    private static func contextWindow(
        in content: String,
        around anchor: Range<String.Index>?
    ) -> String {
        let limit = maximumContextCharactersPerSource
        guard content.count > limit else { return content }
        guard let anchor else { return String(content.prefix(limit)) }

        let anchorStart = content.distance(from: content.startIndex, to: anchor.lowerBound)
        let anchorEnd = content.distance(from: content.startIndex, to: anchor.upperBound)
        let anchorMiddle = anchorStart + ((anchorEnd - anchorStart) / 2)
        let startOffset = min(max(0, anchorMiddle - (limit / 2)), content.count - limit)
        let start = content.index(content.startIndex, offsetBy: startOffset)
        let end = content.index(start, offsetBy: limit)
        return String(content[start..<end])
    }

    private static let evidenceSearchOptions: String.CompareOptions = [
        .caseInsensitive,
        .diacriticInsensitive,
        .widthInsensitive
    ]

    private static func compoundKind(for value: String) -> CompoundKind? {
        guard !value.isEmpty else { return nil }
        if value.unicodeScalars.allSatisfy(isKatakana) {
            return .katakana
        }
        if value.unicodeScalars.allSatisfy(isASCIIAlphanumeric) {
            return .asciiAlphanumeric
        }
        return nil
    }

    private static func isKatakana(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.value {
        case 0x30A1...0x30FA, 0x30FC...0x30FF, 0x31F0...0x31FF:
            true
        default:
            false
        }
    }

    private static func isASCIIAlphanumeric(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.value {
        case 0x30...0x39, 0x61...0x7A:
            true
        default:
            false
        }
    }
}
