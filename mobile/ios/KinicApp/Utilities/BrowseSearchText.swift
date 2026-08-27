// Where: mobile/ios/KinicApp/Utilities/BrowseSearchText.swift
// What: Exact-term emphasis for native search result text.
// Why: Matching words should be visible without relying on color alone.

import Foundation

enum BrowseSearchText {
    static func highlighted(_ text: String, query: String) -> AttributedString {
        var result = AttributedString(text)
        let terms = query
            .split(whereSeparator: \Character.isWhitespace)
            .map(String.init)
            .filter { !$0.isEmpty }

        for term in terms {
            var remainingRange = text.startIndex..<text.endIndex
            while let match = text.range(
                of: term,
                options: [.caseInsensitive, .diacriticInsensitive],
                range: remainingRange
            ) {
                if let lowerBound = AttributedString.Index(match.lowerBound, within: result),
                   let upperBound = AttributedString.Index(match.upperBound, within: result) {
                    result[lowerBound..<upperBound].inlinePresentationIntent = .stronglyEmphasized
                }
                remainingRange = match.upperBound..<text.endIndex
            }
        }
        return result
    }
}
