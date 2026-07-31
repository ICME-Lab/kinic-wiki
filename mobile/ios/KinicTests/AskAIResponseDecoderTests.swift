// Where: mobile/ios/KinicTests/AskAIResponseDecoderTests.swift
// What: Complete tagged-answer and citation validation tests.
// Why: Malformed or unsupported model text must never reach the UI.

import Testing
@testable import Kinic

struct AskAIResponseDecoderTests {
    @Test
    func acceptsSupportedAnswerAndKnownSources() throws {
        let outcome = try AskAIResponseDecoder.decode(
            "\n<sources>S1, S2</sources>\n<answer>Grounded answer.</answer>\n",
            validSourceIDs: ["S1", "S2"]
        )
        #expect(outcome == .supported(sourceIDs: ["S1", "S2"], answer: "Grounded answer."))
    }

    @Test
    func acceptsEmptyInsufficientResult() throws {
        #expect(
            try AskAIResponseDecoder.decode(
                "<sources></sources><answer></answer>",
                validSourceIDs: ["S1"]
            ) == .insufficient
        )
    }

    @Test(arguments: [
        "Answer only",
        "<answer>Answer</answer><sources>S1</sources>",
        "text<sources>S1</sources><answer>Answer</answer>",
        "<sources>S1</sources><answer>Answer</answer>text",
        "<sources>S1</sources><sources>S1</sources><answer>Answer</answer>",
        "<sources>S1</sources><answer>Answer"
    ])
    func rejectsMalformedOrDuplicateTags(_ response: String) {
        #expect(throws: AskAIResponseError.invalidFormat) {
            try AskAIResponseDecoder.decode(response, validSourceIDs: ["S1"])
        }
    }

    @Test
    func rejectsUnknownDuplicateOrMissingSourcesForAnswer() {
        for response in [
            "<sources>S9</sources><answer>Answer</answer>",
            "<sources>S1,S1</sources><answer>Answer</answer>",
            "<sources></sources><answer>Answer</answer>"
        ] {
            #expect(throws: AskAIResponseError.invalidSources) {
                try AskAIResponseDecoder.decode(response, validSourceIDs: ["S1"])
            }
        }
    }

    @Test
    func rejectsSourcesWithoutAnswer() {
        #expect(throws: AskAIResponseError.emptyAnswer) {
            try AskAIResponseDecoder.decode(
                "<sources>S1</sources><answer>  </answer>",
                validSourceIDs: ["S1"]
            )
        }
    }
}
