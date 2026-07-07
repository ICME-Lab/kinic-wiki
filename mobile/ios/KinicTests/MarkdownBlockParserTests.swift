// Where: mobile/ios/KinicTests/MarkdownBlockParserTests.swift
// What: Markdown preview parser tests for native wiki browsing.
// Why: Rendering stays intentionally small, so the supported block contract must be explicit.

import Testing
@testable import Kinic

struct MarkdownBlockParserTests {
    @Test
    func parsesCommonWikiBlocks() {
        let blocks = MarkdownBlockParser().parse(
            """
            # Title

            Intro with **strong** text.

            - first
            - second

            1. step one
            2. step two

            > quoted
            > evidence

            ```swift
            let value = 1
            ```
            """
        )

        #expect(blocks == [
            .heading(level: 1, text: "Title"),
            .paragraph("Intro with **strong** text."),
            .bulletList(["first", "second"]),
            .numberedList(["step one", "step two"]),
            .quote("quoted\nevidence"),
            .codeBlock(language: "swift", code: "let value = 1")
        ])
    }

    @Test
    func keepsParagraphsUntilNextBlock() {
        let blocks = MarkdownBlockParser().parse(
            """
            First line
            second line
            ## Next
            text
            """
        )

        #expect(blocks == [
            .paragraph("First line\nsecond line"),
            .heading(level: 2, text: "Next"),
            .paragraph("text")
        ])
    }

    @Test
    func acceptsUnclosedFencedCode() {
        let blocks = MarkdownBlockParser().parse(
            """
            ~~~
            cargo test
            """
        )

        #expect(blocks == [
            .codeBlock(language: nil, code: "cargo test")
        ])
    }
}
