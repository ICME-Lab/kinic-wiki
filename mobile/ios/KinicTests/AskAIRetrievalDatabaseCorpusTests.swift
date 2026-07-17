// Where: mobile/ios/KinicTests/AskAIRetrievalDatabaseCorpusTests.swift
// What: AI-query retrieval regressions derived from the current testDB vocabulary.
// Why: Real bilingual terms and cross-topic noise expose failures that isolated tokenizer tests miss.

import Testing
@testable import Kinic

struct AskAIRetrievalDatabaseCorpusTests {
    @Test
    func currentDatabaseTopicsKeepOnlyTheirMatchingNote() {
        let cases: [(queries: [String], path: String)] = [
            (["カオマンガイ 材料", "khao man gai recipe"], "/Wiki/recipes/easy-khao-man-gai-recipe-ajinomoto.md"),
            (["ブリ 春菊 カルパッチョ 作り方"], "/Wiki/recipes/buri-shungiku-carpaccio-salad.md"),
            (["スピントロニクス 確率 コンピュータ cmos"], "/Wiki/research/computing/spintronics-probabilistic-computer-cmos-integration.md"),
            (["taalas ai chip investment", "taalas ai チップ 投資"], "/Wiki/investing/ai-chips/toushisen-no-sentei.md"),
            (["ic-hono cloudflare workers compatibility"], "/Wiki/tech/icp/ic-hono.md"),
            (["x402 paid api route"], "/Wiki/tech/icp/x402-paid-api-route-catalog-audit-log.md"),
            (["llm wiki 知識 繋げる"], "/Wiki/tech/knowledge-management/karpathy-llm-wiki-connecting-knowledge.md"),
            (["web サービス 公開 セキュリティ"], "/Wiki/tech/web/web-service-checklist.md"),
            (["鶏むね肉 炊飯器 料理", "chicken breast rice cooker"], "/Wiki/recipes/easy-khao-man-gai-recipe-ajinomoto.md"),
            (["payment-signature paid endpoint"], "/Wiki/tech/icp/x402-paid-api-route-catalog-audit-log.md"),
            (["quickjs hono compatibility"], "/Wiki/tech/icp/ic-hono.md"),
            (["ヒミカ 100時間修行", "ヒミカ 修行相手"], "/Wiki/fiction/kakuyomu/teimaa-shujinkou/teimaa-shujinkou-127-2.md"),
            (["seo 確認", "決済 確認"], "/Wiki/tech/web/web-service-checklist.md")
        ]

        for testCase in cases {
            #expect(
                verifiedPaths(for: plan(testCase.queries)) == [testCase.path],
                "Queries: \(testCase.queries)"
            )
        }
    }

    @Test
    func questionsOutsideCurrentDatabaseRejectBroadSearchNoise() {
        for query in [
            "京都 桜 名所",
            "量子 暗号 衛星 通信",
            "swiftui navigationstack usage",
            "火星 探査機 着陸 地点"
        ] {
            #expect(verifiedPaths(for: plan([query])).isEmpty, "Query: \(query)")
        }
    }

    @Test
    func khaoManGaiRejectsSpintronicsSourceWithFragmentNoise() {
        let queryPlan = plan(["カオマンガイ 材料"])
        #expect(!AskAIRetrievalPlanner.hasRequiredExactMatches(
            queryPlan: queryPlan,
            path: "/Sources/raw/web/743450c953214fbf.md",
            content: "ノイマン型コンピュータ。ガイドブック。特殊なプロセスと材料が必要。"
        ))
    }

    private func verifiedPaths(for queryPlan: AskAIQueryPlan) -> [String] {
        let broadHits = databaseNotes.map { note in
            SearchNodeHit(
                path: note.path,
                kind: .file,
                snippet: nil,
                previewExcerpt: nil,
                matchReasons: ["broad_search"],
                score: -1
            )
        }
        let candidates = AskAIRetrievalPlanner.rankedCandidates(
            queryPlan: queryPlan,
            hitsByQuery: Dictionary(uniqueKeysWithValues: queryPlan.queries.map { ($0.text, broadHits) })
        )

        return candidates.compactMap { candidate in
            guard let note = databaseNotes.first(where: { $0.path == candidate.hit.path }) else { return nil }
            return AskAIRetrievalPlanner.hasRequiredExactMatches(
                queryPlan: queryPlan,
                path: note.path,
                content: note.content
            ) ? note.path : nil
        }
    }

    private func plan(_ queries: [String]) -> AskAIQueryPlan {
        AskAIQueryPlan(queries: queries.map { query in
            .init(text: query, terms: query.split(separator: " ").map(String.init))
        })
    }

    private var databaseNotes: [(path: String, content: String)] {
        [
            ("/Wiki/recipes/easy-khao-man-gai-recipe-ajinomoto.md", "簡単カオマンガイのレシピ。米、鶏むね肉、香味ペーストを炊飯器で一緒に炊く材料と手順。"),
            ("/Wiki/recipes/buri-shungiku-carpaccio-salad.md", "ブリと春菊のカルパッチョ風サラダ。ナンプラー、柚子、焼き海苔を使う。"),
            ("/Wiki/research/computing/spintronics-probabilistic-computer-cmos-integration.md", "スピントロニクス確率コンピュータのCMOS集積化。確率ビットをシリコンチップへ統合した。"),
            ("/Wiki/investing/ai-chips/toushisen-no-sentei.md", "Taalasのような特化型AIチップに焦点を当てた投資候補を整理する。"),
            ("/Wiki/tech/icp/ic-hono.md", "ic-hono is a QuickJS canister-native Hono runtime. Full Cloudflare Workers compatibility is not supported."),
            ("/Wiki/tech/icp/x402-paid-api-route-catalog-audit-log.md", "x402 Paid API Route Catalog with PAYMENT-SIGNATURE and separate pricing for each endpoint."),
            ("/Wiki/tech/knowledge-management/karpathy-llm-wiki-connecting-knowledge.md", "LLM Wikiを運用し、複数ソースの知識を繋げる方法を説明する。"),
            ("/Wiki/tech/web/web-service-checklist.md", "Webサービス公開前のチェックリスト。セキュリティ、ログイン、SEO、決済を確認する。"),
            ("/Wiki/fiction/kakuyomu/teimaa-shujinkou/teimaa-shujinkou-127-2.md", "ヒミカはヨツムギの道場で修行し、100時間の素振りを続ける。ヨツムギが修行相手となる。")
        ]
    }
}
