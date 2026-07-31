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

    @Test
    func queryPromptKeepsLatestTurnsWhenAnOlderAssistantMessageExceedsHistoryBudget() {
        let history = [
            AskAIMessage(role: .user, text: "old topic"),
            AskAIMessage(role: .assistant, text: "OLD-BEGIN " + String(repeating: "x", count: 7_000)),
            AskAIMessage(role: .user, text: "LATEST-USER follow-up"),
            AskAIMessage(role: .assistant, text: "LATEST-ASSISTANT context")
        ]

        let prompt = AskAIQueryPlanner.buildPrompt(
            databaseTitle: "Test DB",
            question: "What about that?",
            history: history
        )

        #expect(prompt.contains("USER: LATEST-USER follow-up"))
        #expect(prompt.contains("ASSISTANT: LATEST-ASSISTANT context"))
        #expect(!prompt.contains("OLD-BEGIN"))
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
            content: "簡単カオマンガイの材料と手順"
        ))
        #expect(!AskAIRetrievalPlanner.hasRequiredExactMatches(
            queryPlan: plan,
            content: "ノイマン型のガイドブックには特殊な材料が必要"
        ))
    }

    @Test
    func exactVerificationHandlesEnglishVariantsAndIdentifierBoundaries() {
        let x402 = plan("x402 paid api route")
        let hono = plan("ic-hono cloudflare workers compatibility")

        #expect(AskAIRetrievalPlanner.hasRequiredExactMatches(
            queryPlan: x402,
            content: "x402 Paid API Route Catalog"
        ))
        #expect(AskAIRetrievalPlanner.hasRequiredExactMatches(
            queryPlan: hono,
            content: "ic-hono has no full Cloudflare Workers compatibility."
        ))
    }

    @Test
    func queryAndEvidenceUseTheSameJapaneseTokenContext() {
        let queryPlan = plan("鶏むね肉 炊飯器 料理")

        #expect(AskAIRetrievalPlanner.hasRequiredExactMatches(
            queryPlan: queryPlan,
            content: "米、鶏むね肉、香味ペーストを炊飯器で一緒に炊くレシピ。"
        ))
    }

    @Test
    func exactPhraseCompensationDoesNotTurnOneTokenIntoSubstringMatching() {
        let queryPlan = plan("猫")

        #expect(!AskAIRetrievalPlanner.hasRequiredExactMatches(
            queryPlan: queryPlan,
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

    @Test
    func retrievalVerifierPreservesExactMatchBehaviorAcrossActorBoundary() async {
        let verifier = AskAIRetrievalVerifier()
        let queryPlan = AskAIQueryPlan(
            queries: [
                .init(
                    text: "ic-hono cloudflare workers compatibility",
                    terms: ["ic-hono", "cloudflare", "workers", "compatibility"]
                )
            ]
        )

        let matches = await verifier.hasRequiredExactMatches(
            queryPlan: queryPlan,
            content: "ic-hono does not provide full Cloudflare Workers compatibility."
        )
        let rejectsNoise = await verifier.hasRequiredExactMatches(
            queryPlan: queryPlan,
            content: "An unrelated document about SwiftUI navigation."
        )

        #expect(matches)
        #expect(!rejectsNoise)
    }

    @Test
    func retrievalVerifierPreparesLateExactEvidenceAcrossActorBoundary() async throws {
        let verifier = AskAIRetrievalVerifier()
        let queryPlan = plan("cat dog")
        let content = "catdog "
            + String(repeating: "unrelated filler ", count: 250)
            + "cat dog authoritative answer"

        let evidence = await verifier.prepareVerifiedEvidence(
            queryPlan: queryPlan,
            hit: hit(path: "/Knowledge/animals.md", score: -1),
            content: content
        )

        let verifiedEvidence = try #require(evidence)
        #expect(verifiedEvidence.content.contains("cat dog authoritative answer"))
        #expect(!verifiedEvidence.content.hasPrefix("catdog"))
    }

    @Test
    func retrievalVerifierPrefersVerifiedPreviewAcrossActorBoundary() async throws {
        let verifier = AskAIRetrievalVerifier()
        let preview = "alpha beta preview-adjacent supported answer"
        let content = "EARLY alpha beta marker "
            + String(repeating: "filler ", count: 700)
            + preview

        let evidence = await verifier.prepareVerifiedEvidence(
            queryPlan: plan("alpha beta"),
            hit: hit(
                path: "/Knowledge/preview.md",
                score: -1,
                previewExcerpt: preview
            ),
            content: content
        )

        let verifiedEvidence = try #require(evidence)
        #expect(verifiedEvidence.excerpt == preview)
        #expect(!verifiedEvidence.content.contains("EARLY alpha beta marker"))
    }

    @Test
    func retrievalVerifierRejectsPathOnlyMatchesAcrossActorBoundary() async {
        let verifier = AskAIRetrievalVerifier()

        let evidence = await verifier.prepareVerifiedEvidence(
            queryPlan: plan("alpha beta"),
            hit: hit(path: "/Knowledge/alpha-beta.md", score: -1),
            content: "This document contains unrelated evidence."
        )

        #expect(evidence == nil)
    }

    @Test
    func evidenceWindowIncludesLateQueryTermsWithoutSearchPreview() {
        let queryPlan = plan("x402 paid api route")
        let content = String(repeating: "unrelated introduction ", count: 220)
            + "x402 paid api route requires PAYMENT-SIGNATURE for the supported answer."
        let evidence = AskAIRetrievalPlanner.prepareEvidence(
            queryPlan: queryPlan,
            hit: hit(path: "/Knowledge/payments.md", score: -1),
            content: content
        )

        #expect(evidence.content.count <= AskAIRetrievalPlanner.maximumContextCharactersPerSource)
        #expect(evidence.content.contains("PAYMENT-SIGNATURE for the supported answer"))
        #expect(AskAIRetrievalPlanner.hasRequiredExactMatches(
            queryPlan: queryPlan,
            content: "\(evidence.excerpt)\n\(evidence.content)"
        ))
        let builtPrompt = AskAIPromptBuilder.build(
            databaseTitle: "Payments",
            question: "How is the route authenticated?",
            history: [],
            sources: [
                AskAIContextSource(
                    source: AskAISource(
                        id: "S1",
                        path: "/Knowledge/payments.md",
                        excerpt: evidence.excerpt,
                        score: -1,
                        matchReasons: ["content_fts"]
                    ),
                    content: evidence.content
                )
            ]
        )
        #expect(builtPrompt.message.contains("PAYMENT-SIGNATURE for the supported answer"))
    }

    @Test
    func lateExactTermsAreNotShadowedByEarlierSubstringMatches() {
        let queryPlan = plan("cat dog")
        let content = "catdog "
            + String(repeating: "unrelated filler ", count: 250)
            + "cat dog authoritative answer"
        let evidence = AskAIRetrievalPlanner.prepareEvidence(
            queryPlan: queryPlan,
            hit: hit(path: "/Knowledge/animals.md", score: -1),
            content: content
        )

        #expect(evidence.content.contains("cat dog authoritative answer"))
        #expect(!evidence.content.hasPrefix("catdog"))
        #expect(AskAIRetrievalPlanner.hasRequiredExactMatches(
            queryPlan: queryPlan,
            content: "\(evidence.excerpt)\n\(evidence.content)"
        ))
    }

    @Test
    func evidenceWindowPrefersSearchPreviewOverEarlierQueryMatch() {
        let queryPlan = plan("alpha beta")
        let preview = "alpha beta preview-adjacent supported answer"
        let content = "EARLY alpha beta marker "
            + String(repeating: "filler ", count: 700)
            + preview
        let evidence = AskAIRetrievalPlanner.prepareEvidence(
            queryPlan: queryPlan,
            hit: hit(path: "/Knowledge/preview.md", score: -1, previewExcerpt: preview),
            content: content
        )

        #expect(evidence.content.contains("preview-adjacent supported answer"))
        #expect(!evidence.content.contains("EARLY alpha beta marker"))
        #expect(evidence.excerpt == preview)
    }

    @Test
    func evidenceWindowFallsBackWhenSearchPreviewDoesNotMatchTheQuery() {
        let queryPlan = plan("alpha beta")
        let preview = "selected preview with unrelated evidence"
        let content = "alpha beta only appears here "
            + String(repeating: "filler ", count: 700)
            + preview
        let evidence = AskAIRetrievalPlanner.prepareEvidence(
            queryPlan: queryPlan,
            hit: hit(path: "/Knowledge/note.md", score: -1, previewExcerpt: preview),
            content: content
        )

        #expect(AskAIRetrievalPlanner.hasRequiredExactMatches(
            queryPlan: queryPlan,
            content: "\(evidence.excerpt)\n\(evidence.content)"
        ))
        #expect(evidence.content.contains("alpha beta only appears here"))
        #expect(!evidence.content.contains("selected preview with unrelated evidence"))
    }

    @Test
    func exactVerificationRejectsTermsFoundOnlyInThePath() {
        let queryPlan = plan("alpha beta")

        #expect(!AskAIRetrievalPlanner.hasRequiredExactMatches(
            queryPlan: queryPlan,
            content: "This document contains unrelated evidence."
        ))
    }

    private func plan(_ query: String) -> AskAIQueryPlan {
        AskAIQueryPlan(queries: [.init(text: query, terms: query.split(separator: " ").map(String.init))])
    }

    private func hit(
        path: String,
        score: Float,
        previewExcerpt: String? = nil
    ) -> SearchNodeHit {
        SearchNodeHit(
            path: path,
            kind: .file,
            snippet: nil,
            previewExcerpt: previewExcerpt,
            matchReasons: ["content_fts"],
            score: score
        )
    }
}
