// Where: mobile/ios/KinicTests/AskAIRetrievalPlannerTests.swift
// What: AI query-plan parsing, semantic-token verification, and stable ranking tests.
// Why: Query rewriting is mandatory and broad search hits must still pass deterministic evidence checks.

import Testing
@testable import Kinic

struct AskAIRetrievalPlannerTests {
    @Test
    func recoveryPromptUsesHistoryReferentAndExcludesPreviousQueries() throws {
        let previous = try AskAIQueryPlanner.parse(
            "<answer>デザインツール 日本語\nデザインツール 対応\nデザインツール</answer>"
        )
        let history = [
            AskAIMessage(role: .user, text: "pre-design-mdについて教えて"),
            AskAIMessage(role: .assistant, text: "デザインの土台を決めるツールです。")
        ]

        let prompt = AskAIQueryPlanner.buildRecoveryPrompt(
            databaseTitle: "memo",
            question: "例のツールは日本語対応？",
            history: history,
            previousPlan: previous
        )
        let recovered = try AskAIQueryPlanner.parseRecovery(
            "<answer>pre-design-md 日本語\npre-design-md japanese support\npre-design-md</answer>",
            excluding: previous
        )

        #expect(prompt.contains("USER: pre-design-mdについて教えて"))
        #expect(prompt.contains("デザインツール 日本語"))
        #expect(recovered.queries.map(\.text) == [
            "pre-design-md 日本語", "pre-design-md japanese support", "pre-design-md"
        ])
    }

    @Test
    func recoveryRejectsOnlyRepeatedQueries() throws {
        let previous = try AskAIQueryPlanner.parse(
            "<answer>pre-design-md 日本語\npre-design-md 対応\npre-design-md</answer>"
        )

        #expect(throws: AskAIQueryPlanError.invalidFormat) {
            try AskAIQueryPlanner.parseRecovery(
                "<answer>日本語 PRE-DESIGN-MD\n対応 pre-design-md\npre-design-md</answer>",
                excluding: previous
            )
        }
    }

    @Test
    func recoveryEnrichmentDoesNotRestoreAnExcludedAnchor() throws {
        let history = [
            AskAIMessage(role: .user, text: "pre-design-mdについて教えて"),
            AskAIMessage(role: .assistant, text: "デザインの土台を決めるツールです。")
        ]
        let initialModelPlan = try AskAIQueryPlanner.parse(
            "<answer>デザインツール 日本語\nデザインツール 対応\nデザインツール</answer>"
        )
        let initialPlan = AskAIQueryPlanner.enriched(
            initialModelPlan,
            question: "例のツールは日本語対応？",
            history: history
        )
        let parsedRecoveryPlan = try AskAIQueryPlanner.parseRecovery(
            "<answer>pre-design-md 日本語\npre-design-md japanese support\n日本語対応</answer>",
            excluding: initialPlan
        )
        let recoveryPlan = AskAIQueryPlanner.enriched(
            parsedRecoveryPlan,
            question: "例のツールは日本語対応？",
            history: history,
            excluding: initialPlan
        )

        #expect(initialPlan.queries.map(\.text).contains("pre-design-md"))
        #expect(!recoveryPlan.queries.map(\.text).contains("pre-design-md"))
        #expect(recoveryPlan.queries.count == 3)
    }

    @Test
    func enrichmentPreservesCurrentAndHistoryAnchors() throws {
        let modelPlan = try AskAIQueryPlanner.parse(
            "<answer>font selection tool\nvisual design tools\ntypography tools</answer>"
        )
        let indirect = AskAIQueryPlanner.enriched(
            modelPlan,
            question: "AIに画面を作らせる前、フォントや余白を目で選ぶツールを教えて。",
            history: []
        )
        let followup = AskAIQueryPlanner.enriched(
            modelPlan,
            question: "例のツールは日本語対応？",
            history: [
                AskAIMessage(role: .user, text: "pre-design-mdについて教えて"),
                AskAIMessage(role: .assistant, text: "デザインの土台を決めるツールです。")
            ]
        )
        let typo = AskAIQueryPlanner.enriched(
            modelPlan,
            question: "predesign md のdesign harnessって何？",
            history: []
        )

        #expect(indirect.queries.last?.text == "フォント")
        #expect(followup.queries.last?.text == "pre-design-md")
        #expect(typo.queries.last?.text == "predesign md")
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
        let normalized = query.lowercased()
        let firstTerm = String(normalized.split(whereSeparator: \.isWhitespace)[0])
        let expected = ["llm", "web"].contains(firstTerm)
            ? [normalized]
            : [normalized, firstTerm]
        #expect(plan.queries.map(\.text) == expected)
    }

    @Test
    func addsLiteralFirstTermAsSafeAnchorWhenModelReturnsOneMultiTermQuery() throws {
        let plan = try AskAIQueryPlanner.parse("<answer>貴金属 鞘</answer>")

        #expect(plan.queries == [
            .init(text: "貴金属 鞘", terms: ["貴金属", "鞘"]),
            .init(text: "貴金属", terms: ["貴金属"])
        ])
    }

    @Test
    func keepsSingleTermQueryWithoutManufacturingAnotherConcept() throws {
        let plan = try AskAIQueryPlanner.parse("<answer>x402</answer>")

        #expect(plan.queries == [.init(text: "x402", terms: ["x402"])])
    }

    @Test
    func appendsDistinctiveAnchorWithoutDiscardingThreeModelQueries() throws {
        let plan = try AskAIQueryPlanner.parse("""
        <answer>
        キオクシア 11万円 ファンダ
        キオクシア 11万円
        キオクシア 価格
        </answer>
        """)

        #expect(plan.queries.map(\.text) == [
            "キオクシア 11万円 ファンダ",
            "キオクシア 11万円",
            "キオクシア 価格",
            "キオクシア"
        ])
    }

    @Test
    func appendsSpacedVersionAnchorForJoinedModelName() throws {
        let plan = try AskAIQueryPlanner.parse("""
        <answer>
        gemma4 long context attention
        gemma4 attention ratio
        attention long context
        </answer>
        """)

        #expect(plan.queries.last == .init(text: "gemma 4", terms: ["gemma", "4"]))
    }

    @Test
    func doesNotAppendGenericShortASCIIAnchor() throws {
        let plan = try AskAIQueryPlanner.parse("""
        <answer>
        ui component examples
        design systems examples
        component design system
        </answer>
        """)

        #expect(plan.queries.count == 3)
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

        #expect(plan.queries.map(\.text) == ["x402 paid api route", "x402 有料 api ルート", "x402"])
        #expect(plan.queries[0].terms == ["x402", "paid", "api", "route"])
    }

    @Test(arguments: [
        "explanation<answer>x402 api</answer>",
        "```\n<answer>x402 api</answer>\n```",
        "<answer>\n- x402 api\n</answer>",
        "<answer>\n1. x402 api\n</answer>",
        "<answer>\n10. x402 api\n</answer>",
        "<answer>one two three four five six seven eight nine</answer>",
        "<answer>\none\n\ntwo\n</answer>",
        "<answer>\none\ntwo\nthree\nfour\n</answer>",
        "<answer></answer>",
        "<answer>pre-design md</pre-design md</pre-design md</answer>",
        "<answer>one</answer><answer>two</answer>"
    ])
    func rejectsInvalidQueryPlanOutput(_ response: String) {
        #expect(throws: AskAIQueryPlanError.invalidFormat) {
            try AskAIQueryPlanner.parse(response)
        }
    }

    @Test
    func acceptsLongerModelQueriesWithinTheBound() throws {
        let plan = try AskAIQueryPlanner.parse(
            "<answer>processed financial time series distribution method</answer>"
        )

        #expect(plan.queries.first?.terms == [
            "processed", "financial", "time", "series", "distribution", "method"
        ])
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
    func diversifiedQueriesRecoverARelevantNoteWhenLiteralTermsUseDifferentWording() {
        let diversified = AskAIQueryPlan(queries: [
            .init(text: "貴金属 鞘", terms: ["貴金属", "鞘"]),
            .init(text: "貴金属 エッジ", terms: ["貴金属", "エッジ"]),
            .init(text: "貴金属", terms: ["貴金属"])
        ])
        let content = "週末の貴金属取引で月次A級になったエッジを整理する。"
        let relevantHit = hit(path: "/Sources/週末貴金属エッジ.md", score: -10)
        let candidates = AskAIRetrievalPlanner.rankedCandidates(
            queryPlan: diversified,
            hitsByQuery: [
                "貴金属 鞘": [],
                "貴金属 エッジ": [relevantHit],
                "貴金属": [relevantHit]
            ]
        )

        #expect(candidates.map(\.hit.path) == [relevantHit.path])
        #expect(candidates.first?.matchedQueryCount == 2)
        #expect(AskAIRetrievalPlanner.hasRequiredExactMatches(
            queryPlan: diversified,
            content: content
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
            ],
            outputLanguage: .english
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
