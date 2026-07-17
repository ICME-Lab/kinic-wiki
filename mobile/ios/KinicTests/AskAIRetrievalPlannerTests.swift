// Where: mobile/ios/KinicTests/AskAIRetrievalPlannerTests.swift
// What: AI query-plan parsing, semantic-token verification, and stable ranking tests.
// Why: Query rewriting is mandatory and broad search hits must still pass deterministic evidence checks.

import Testing
@testable import Kinic

struct AskAIRetrievalPlannerTests {
    @Test
    func queryPromptIncludesCurrentQuestionDatabaseAndBoundedHistory() {
        let history = (1...8).map { index in
            AskAIMessage(role: index.isMultiple(of: 2) ? .assistant : .user, text: "message \(index)")
        }
        let prompt = AskAIQueryPlanner.buildPrompt(
            databaseTitle: "Test DB",
            question: "それの互換性は？",
            history: history
        )

        #expect(prompt.contains("Database: Test DB"))
        #expect(prompt.contains("CURRENT QUESTION:\nそれの互換性は？"))
        #expect(!prompt.contains("message 1"))
        #expect(!prompt.contains("message 2"))
        #expect(prompt.contains("message 3"))
        #expect(prompt.contains("only to resolve a pronoun"))
        #expect(prompt.contains("Never copy an unrelated earlier topic"))
        #expect(prompt.contains("one leading blank line before the opening tag"))
        #expect(prompt.contains("<answer> is not the first generated token"))
        #expect(prompt.contains("Forbidden: answering the question, Markdown fences"))
        #expect(prompt.contains("database name as a search term"))
    }

    @Test(arguments: [
        "Kakuyomu 小説 ルーム",
        "カオマンガイ 材料",
        "x402 paid api route",
        "ic-hono cloudflare workers compatibility",
        "taalas ai チップ 投資",
        "llm wiki knowledge",
        "web security checklist"
    ])
    func parsesRepresentativeQueryWording(_ query: String) throws {
        let plan = try AskAIQueryPlanner.parse("<answer>\n\(query)\n</answer>")
        #expect(plan.queries.map(\.text) == [query.lowercased()])
    }

    @Test
    func normalizesWidthCaseAndDeduplicatesQueries() throws {
        let plan = try AskAIQueryPlanner.parse("""
        <answer>
        Ｘ４０２ Paid API Route
        x402 paid api route
        X402 有料 API ルート
        </answer>
        """)

        #expect(plan.queries.map(\.text) == ["x402 paid api route", "x402 有料 api ルート"])
        #expect(plan.queries[0].terms == ["x402", "paid", "api", "route"])
    }

    @Test(arguments: [
        "explanation<answer>x402 api</answer>",
        "```\n<answer>x402 api</answer>\n```",
        "<answer>\n- x402 api\n</answer>",
        "<answer>\n1. x402 api\n</answer>",
        "<answer>\n10. x402 api\n</answer>",
        "<answer>one two three four five</answer>",
        "<answer>\none\n\ntwo\n</answer>",
        "<answer>\none\ntwo\nthree\nfour\n</answer>",
        "<answer></answer>",
        "<answer>one</answer><answer>two</answer>"
    ])
    func rejectsInvalidQueryPlanOutput(_ response: String) {
        #expect(throws: AskAIQueryPlanError.invalidFormat) {
            try AskAIQueryPlanner.parse(response)
        }
    }

    @Test
    func semanticTokensNormalizeCompoundsAndPunctuationBoundaries() {
        #expect(AskAIRetrievalPlanner.semanticTokens(in: "ｶｵﾏﾝｶﾞｲ") == ["カオマンガイ"])
        #expect(AskAIRetrievalPlanner.semanticTokens(in: "x402") == ["x402"])
        #expect(AskAIRetrievalPlanner.semanticTokens(in: "ic-hono") == ["ic", "hono"])
        #expect(AskAIRetrievalPlanner.semanticTokens(in: "画像生成") == ["画像", "生成"])
        #expect(AskAIRetrievalPlanner.semanticTokens(in: "カオ マン ガイ") == ["カオ", "マン", "ガイ"])
        #expect(AskAIRetrievalPlanner.semanticTokens(in: "猫") == ["猫"])
    }

    @Test
    func exactVerificationAcceptsAnyQueryMajorityAndRejectsKatakanaFragmentNoise() {
        let plan = AskAIQueryPlan(queries: [
            .init(text: "カオマンガイ 材料", terms: ["カオマンガイ", "材料"]),
            .init(text: "khao man gai recipe", terms: ["khao", "man", "gai", "recipe"])
        ])

        #expect(AskAIRetrievalPlanner.hasRequiredExactMatches(
            queryPlan: plan,
            path: "/Wiki/recipes/khao-man-gai.md",
            content: "簡単カオマンガイの材料と手順"
        ))
        #expect(!AskAIRetrievalPlanner.hasRequiredExactMatches(
            queryPlan: plan,
            path: "/Sources/spintronics.md",
            content: "ノイマン型のガイドブックには特殊な材料が必要"
        ))
    }

    @Test
    func exactVerificationHandlesEnglishVariantsAndIdentifierBoundaries() {
        let x402 = plan("x402 paid api route")
        let hono = plan("ic-hono cloudflare workers compatibility")

        #expect(AskAIRetrievalPlanner.hasRequiredExactMatches(
            queryPlan: x402,
            path: "/Wiki/x402-paid-api-route.md",
            content: "x402 Paid API Route Catalog"
        ))
        #expect(AskAIRetrievalPlanner.hasRequiredExactMatches(
            queryPlan: hono,
            path: "/Wiki/ic-hono.md",
            content: "Full Cloudflare Workers compatibility is not supported."
        ))
    }

    @Test
    func queryAndEvidenceUseTheSameJapaneseTokenContext() {
        let queryPlan = plan("鶏むね肉 炊飯器 料理")

        #expect(AskAIRetrievalPlanner.hasRequiredExactMatches(
            queryPlan: queryPlan,
            path: "/Wiki/recipes/khao-man-gai.md",
            content: "米、鶏むね肉、香味ペーストを炊飯器で一緒に炊くレシピ。"
        ))
    }

    @Test
    func exactPhraseCompensationDoesNotTurnOneTokenIntoSubstringMatching() {
        let queryPlan = plan("猫")

        #expect(!AskAIRetrievalPlanner.hasRequiredExactMatches(
            queryPlan: queryPlan,
            path: "/Wiki/food.md",
            content: "熱いものが苦手な猫舌について説明する。"
        ))
    }

    @Test
    func requiresStrictMajority() {
        #expect(AskAIRetrievalPlanner.requiredMatchCount(for: 1) == 1)
        #expect(AskAIRetrievalPlanner.requiredMatchCount(for: 2) == 2)
        #expect(AskAIRetrievalPlanner.requiredMatchCount(for: 3) == 2)
        #expect(AskAIRetrievalPlanner.requiredMatchCount(for: 4) == 3)
    }

    @Test
    func aggregatesQueriesAndUsesScoreThenPathForStableRanking() {
        let queryPlan = AskAIQueryPlan(queries: [
            .init(text: "alpha beta", terms: ["alpha", "beta"]),
            .init(text: "alpha gamma", terms: ["alpha", "gamma"])
        ])
        let a = hit(path: "/a.md", score: -1)
        let b = hit(path: "/b.md", score: -1)
        let c = hit(path: "/c.md", score: -10)
        let candidates = AskAIRetrievalPlanner.rankedCandidates(
            queryPlan: queryPlan,
            hitsByQuery: [
                "alpha beta": [b, a, c],
                "alpha gamma": [b, a]
            ]
        )

        #expect(candidates.map(\.hit.path) == ["/a.md", "/b.md", "/c.md"])
        #expect(candidates.map(\.matchedQueryCount) == [2, 2, 1])
    }

    private func plan(_ query: String) -> AskAIQueryPlan {
        AskAIQueryPlan(queries: [.init(text: query, terms: query.split(separator: " ").map(String.init))])
    }

    private func hit(path: String, score: Float) -> SearchNodeHit {
        SearchNodeHit(
            path: path,
            kind: .file,
            snippet: nil,
            previewExcerpt: nil,
            matchReasons: ["content_fts"],
            score: score
        )
    }
}
