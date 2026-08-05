// Where: mobile/ios/KinicTests/AskAIRouterTests.swift
// What: Strict conversational-route and search-route prompt and decoding tests.
// Why: Malformed model output must never silently become a search or an uncited answer.

import Testing
@testable import Kinic

struct AskAIRouterTests {
    @Test
    func promptIncludesConversationHistoryAndMissingReferentRule() {
        let history = [
            AskAIMessage(role: .user, text: "Write this in English"),
            AskAIMessage(role: .assistant, text: "A concise English sentence.")
        ]

        let prompt = AskAIRouter.buildPrompt(
            databaseTitle: "Test DB",
            question: "日本語にして",
            history: history
        )

        #expect(prompt.contains("REQUEST ROUTER AND CONVERSATIONAL RESPONDER"))
        #expect(prompt.contains("ASSISTANT: A concise English sentence."))
        #expect(prompt.contains("CURRENT QUESTION:\n日本語にして"))
        #expect(prompt.contains("If the requested content is missing for a transformation, ask the user for it"))
        #expect(prompt.contains("A literal query"))
        #expect(prompt.contains("A paraphrase"))
        #expect(prompt.contains("An anchor query"))
        #expect(prompt.contains("always write exactly 3 distinct search-query lines"))
        #expect(prompt.contains("its individual distinctive terms may be the two shorter queries"))
        #expect(prompt.contains("Up to 8 is valid"))
        #expect(prompt.contains("never write 9 or more"))
        #expect(prompt.contains("same language and script as CURRENT QUESTION"))
        #expect(prompt.contains("do not translate Japanese concepts into English"))
        #expect(prompt.contains("Changing only term order is a duplicate"))
        #expect(prompt.contains("Never output a heading or label inside <answer>"))
        #expect(!prompt.contains("<answer>QUERY LINES</answer>"))
    }

    @Test
    func factualFollowupsSearchAndReuseOnlyTheHistoryReferent() {
        let history = [
            AskAIMessage(role: .user, text: "pre-design-mdって何？"),
            AskAIMessage(role: .assistant, text: "デザインの土台を決めるツールです。")
        ]

        let prompt = AskAIRouter.buildPrompt(
            databaseTitle: "memo",
            question: "例のツールの5ステップ全部を教えて。",
            history: history
        )

        #expect(prompt.contains("A factual follow-up requires search"))
        #expect(prompt.contains("earlier assistant answer is never database evidence"))
        #expect(prompt.contains("copy the resolved distinctive identifier"))
        #expect(prompt.contains("USER: pre-design-mdって何？"))
        #expect(AskAIRouter.requiresDatabaseSearch(
            question: "5ステップ全部を教えて。",
            history: history
        ))
        #expect(!AskAIRouter.requiresDatabaseSearch(
            question: "前の回答を短くして。",
            history: history
        ))
    }

    @Test
    func databaseBackedTransformationsSearchWhileConversationTransformsStayDirect() {
        #expect(AskAIRouter.requiresDatabaseSearch(
            question: "このDBのノートを要約して",
            history: []
        ))
        #expect(AskAIRouter.requiresDatabaseSearch(
            question: "summarize my saved notes",
            history: []
        ))
        #expect(!AskAIRouter.requiresDatabaseSearch(
            question: "前の回答を短くして。",
            history: [AskAIMessage(role: .assistant, text: "A long answer")]
        ))
    }

    @Test
    func identityQuestionsRequireSearchWithoutConversationHistory() {
        for question in ["俺の本名は？", "What is my real name?", "Am I the developer?"] {
            #expect(AskAIRouter.requiresDatabaseSearch(question: question, history: []))
        }
    }

    @Test
    func transformationWordsDoNotHardOverrideTheModelRoute() {
        for question in ["Does DeepL translate PDFs?", "What is a rewrite rule?"] {
            let prompt = AskAIRouter.buildPrompt(
                databaseTitle: "memo",
                question: question,
                history: []
            )
            #expect(prompt.contains("REQUIRED MODE: not predetermined"))
        }

        for question in [
            "Translate this: The database is offline.",
            "次の文章を要約して: データベースは情報を整理する仕組みです。"
        ] {
            #expect(!AskAIRouter.requiresDatabaseSearch(question: question, history: []))
            let prompt = AskAIRouter.buildPrompt(
                databaseTitle: "memo",
                question: question,
                history: []
            )
            #expect(prompt.contains("REQUIRED MODE: not predetermined"))
        }
    }

    @Test
    func repairPromptReassertsTheStrictEnvelope() {
        let prompt = AskAIRouter.buildRepairPrompt(
            databaseTitle: "memo",
            question: "pre-design-mdって何？",
            history: []
        )

        #expect(prompt.contains("CORRECTION: Your previous response was invalid or violated REQUIRED MODE"))
        #expect(prompt.contains("Return exactly one of the two allowed <mode>/<answer> structures"))
    }

    @Test
    func promptKeepsLatestTurnsWhenAnOlderMessageExceedsHistoryBudget() {
        let history = [
            AskAIMessage(role: .user, text: "old topic"),
            AskAIMessage(role: .assistant, text: "OLD-BEGIN " + String(repeating: "x", count: 7_000)),
            AskAIMessage(role: .user, text: "LATEST-USER follow-up"),
            AskAIMessage(role: .assistant, text: "LATEST-ASSISTANT context")
        ]

        let prompt = AskAIRouter.buildPrompt(
            databaseTitle: "Test DB",
            question: "What about that?",
            history: history
        )

        #expect(prompt.contains("USER: LATEST-USER follow-up"))
        #expect(prompt.contains("ASSISTANT: LATEST-ASSISTANT context"))
        #expect(!prompt.contains("OLD-BEGIN"))
    }

    @Test
    func parsesDirectConversationAnswer() throws {
        let route = try AskAIRouter.parse(
            "<mode>conversation</mode>\n<answer>こんにちは。</answer>"
        )

        #expect(route == .conversation(answer: "こんにちは。"))
    }

    @Test
    func parsesBoundedSearchPlan() throws {
        let route = try AskAIRouter.parse(
            "<mode>search</mode>\n<answer>貴金属 鞘\n貴金属 エッジ\n貴金属</answer>"
        )

        #expect(route == .search(plan: AskAIQueryPlan(queries: [
            .init(text: "貴金属 鞘", terms: ["貴金属", "鞘"]),
            .init(text: "貴金属 エッジ", terms: ["貴金属", "エッジ"]),
            .init(text: "貴金属", terms: ["貴金属"])
        ])))
    }

    @Test(arguments: [
        "<answer>Unclassified</answer>",
        "<mode>conversation</mode><answer></answer>",
        "<mode>search</mode><answer>one two three four five six seven eight nine</answer>",
        "Explanation<mode>conversation</mode><answer>Hello</answer>",
        "<mode>unknown</mode><answer>Hello</answer>"
    ])
    func rejectsMalformedRoute(_ response: String) {
        #expect(throws: AskAIRouteError.invalidFormat) {
            try AskAIRouter.parse(response)
        }
    }
}
