// Where: mobile/ios/KinicApp/Services/AskAIResponseDecoder.swift
// What: Strictly validates a complete tagged answer and its cited source IDs.
// Why: No model output reaches the conversation until both answer and citations are trustworthy.

import Foundation

enum AskAIResponseDecoder {
    static func decode(_ response: String, validSourceIDs: Set<String>) throws -> AskAIResponseOutcome {
        guard response.components(separatedBy: "<sources>").count == 2,
              response.components(separatedBy: "</sources>").count == 2,
              response.components(separatedBy: "<answer>").count == 2,
              response.components(separatedBy: "</answer>").count == 2,
              let sourcesOpen = response.range(of: "<sources>"),
              let sourcesClose = response.range(of: "</sources>"),
              let answerOpen = response.range(of: "<answer>"),
              let answerClose = response.range(of: "</answer>"),
              sourcesOpen.upperBound <= sourcesClose.lowerBound,
              sourcesClose.upperBound <= answerOpen.lowerBound,
              answerOpen.upperBound <= answerClose.lowerBound,
              response[..<sourcesOpen.lowerBound].allSatisfy(\Character.isWhitespace),
              response[sourcesClose.upperBound..<answerOpen.lowerBound].allSatisfy(\Character.isWhitespace),
              response[answerClose.upperBound...].allSatisfy(\Character.isWhitespace) else {
            throw AskAIResponseError.invalidFormat
        }

        let rawSources = response[sourcesOpen.upperBound..<sourcesClose.lowerBound]
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let answer = response[answerOpen.upperBound..<answerClose.lowerBound]
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let sourceIDs = rawSources
            .split(separator: ",", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }

        if answer.isEmpty {
            return .insufficient
        }
        guard !rawSources.isEmpty,
              !sourceIDs.contains(where: \.isEmpty),
              Set(sourceIDs).count == sourceIDs.count,
              sourceIDs.allSatisfy(validSourceIDs.contains) else {
            throw AskAIResponseError.invalidSources
        }
        return .supported(sourceIDs: sourceIDs, answer: answer)
    }
}

enum AskAIResponseError: Error, LocalizedError, Equatable {
    case invalidFormat
    case invalidSources

    var errorDescription: String? {
        switch self {
        case .invalidFormat:
            "Kinic AI returned an invalid answer format."
        case .invalidSources:
            "Kinic AI referenced evidence that was not provided."
        }
    }
}
