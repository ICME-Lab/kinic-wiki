// Where: mobile/ios/KinicTests/AskAIResponseDecoderTests.swift
// What: Grounding protocol tests for streamed Ask AI output.
// Why: Unsupported or malformed content must be rejected before display.

import Foundation
import Testing
@testable import Kinic

struct AskAIResponseDecoderTests {
    @Test
    func exposesAnswerOnlyAfterValidHeaders() throws {
        var decoder = AskAIResponseDecoder()

        #expect(try decoder.append("GROUNDING: supp", validSourceIDs: ["S1"]) == .pending)
        #expect(try decoder.append("orted\nSOURCES: S1\n\nAnswer", validSourceIDs: ["S1"]) == .supported(sourceIDs: ["S1"], answer: "Answer"))
        #expect(try decoder.append(" continues", validSourceIDs: ["S1"]) == .supported(sourceIDs: ["S1"], answer: "Answer continues"))
        #expect(try decoder.finish() == .supported(sourceIDs: ["S1"], answer: "Answer continues"))
    }

    @Test
    func acceptsInsufficientWithoutAnswer() throws {
        var decoder = AskAIResponseDecoder()

        #expect(try decoder.append("GROUNDING: insufficient\nSOURCES:\n\n", validSourceIDs: ["S1"]) == .insufficient)
        #expect(try decoder.finish() == .insufficient)
    }

    @Test
    func rejectsUnknownOrDuplicateSources() {
        var unknown = AskAIResponseDecoder()
        #expect(throws: AskAIResponseError.invalidSources) {
            try unknown.append("GROUNDING: supported\nSOURCES: S2\n\nAnswer", validSourceIDs: ["S1"])
        }

        var duplicate = AskAIResponseDecoder()
        #expect(throws: AskAIResponseError.invalidSources) {
            try duplicate.append("GROUNDING: supported\nSOURCES: S1,S1\n\nAnswer", validSourceIDs: ["S1"])
        }
    }

    @Test
    func rejectsMissingHeadersAndEmptyAnswers() throws {
        var malformed = AskAIResponseDecoder()
        #expect(throws: AskAIResponseError.invalidGroundingHeaders) {
            try malformed.append("Here is an answer.\n\n", validSourceIDs: ["S1"])
        }

        var empty = AskAIResponseDecoder()
        _ = try empty.append("GROUNDING: supported\nSOURCES: S1\n\n", validSourceIDs: ["S1"])
        #expect(throws: AskAIResponseError.emptyAnswer) {
            try empty.finish()
        }
    }
}
