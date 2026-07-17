// Where: mobile/ios/KinicApp/Services/AskAIResponseDecoder.swift
// What: Incrementally validates grounding headers before exposing streamed answer text.
// Why: General or malformed model output must never flash briefly in the conversation.

import Foundation

struct AskAIResponseDecoder: Sendable {
    private(set) var outcome = AskAIResponseOutcome.pending
    private var headerBuffer = ""
    private var answer = ""
    private var sourceIDs: [String] = []
    private var headersComplete = false

    mutating func append(_ chunk: String, validSourceIDs: Set<String>) throws -> AskAIResponseOutcome {
        if case .insufficient = outcome {
            return outcome
        }

        if headersComplete {
            answer += chunk
            outcome = .supported(sourceIDs: sourceIDs, answer: answer)
            return outcome
        }

        headerBuffer += chunk.replacing("\r\n", with: "\n")
        guard let separator = headerBuffer.range(of: "\n\n") else {
            return .pending
        }

        let header = String(headerBuffer[..<separator.lowerBound])
        let body = String(headerBuffer[separator.upperBound...])
        let lines = header.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        guard lines.count == 2,
              lines[0].hasPrefix("GROUNDING:"),
              lines[1].hasPrefix("SOURCES:") else {
            throw AskAIResponseError.invalidGroundingHeaders
        }

        let grounding = lines[0].dropFirst("GROUNDING:".count).trimmingCharacters(in: .whitespaces)
        let rawSources = lines[1].dropFirst("SOURCES:".count).trimmingCharacters(in: .whitespaces)
        if grounding == "insufficient" {
            guard rawSources.isEmpty else {
                throw AskAIResponseError.invalidGroundingHeaders
            }
            outcome = .insufficient
            return outcome
        }

        guard grounding == "supported" else {
            throw AskAIResponseError.invalidGroundingHeaders
        }
        sourceIDs = rawSources
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        guard !sourceIDs.isEmpty,
              Set(sourceIDs).count == sourceIDs.count,
              sourceIDs.allSatisfy(validSourceIDs.contains) else {
            throw AskAIResponseError.invalidSources
        }

        headersComplete = true
        answer = body
        outcome = .supported(sourceIDs: sourceIDs, answer: answer)
        return outcome
    }

    mutating func finish() throws -> AskAIResponseOutcome {
        switch outcome {
        case .pending:
            throw AskAIResponseError.incompleteResponse
        case let .supported(sourceIDs, answer):
            guard !answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                throw AskAIResponseError.emptyAnswer
            }
            return .supported(sourceIDs: sourceIDs, answer: answer)
        case .insufficient:
            return .insufficient
        }
    }
}

enum AskAIResponseError: Error, LocalizedError, Equatable {
    case invalidGroundingHeaders
    case invalidSources
    case incompleteResponse
    case emptyAnswer

    var errorDescription: String? {
        switch self {
        case .invalidGroundingHeaders:
            "Kinic AI returned an invalid grounding status."
        case .invalidSources:
            "Kinic AI referenced evidence that was not provided."
        case .incompleteResponse:
            "Kinic AI returned an incomplete response."
        case .emptyAnswer:
            "Kinic AI returned an empty answer."
        }
    }
}
