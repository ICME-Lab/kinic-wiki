// Where: mobile/ios/KinicTests/AskAILiveEvaluationTests.swift
// What: Opt-in black-box evaluation against the production Kinic AI endpoint.
// Why: Unit stubs cannot measure live routing accuracy, query diversity, or response stability.

import Foundation
import Testing
@testable import Kinic

struct AskAILiveEvaluationTests {
    private enum ExpectedRoute: String {
        case conversation
        case search
    }

    private struct EvaluationCase {
        let name: String
        let question: String
        let history: [AskAIMessage]
        let expectedRoute: ExpectedRoute
        let requiredSearchAnchor: String?
    }

    private struct GroundedAnswerCase {
        let name: String
        let question: String
        let path: String
        let content: String
        let requiredFactGroups: [[String]]
        let forbiddenAnswerPatterns: [String]
        let expectsInsufficient: Bool

        init(
            name: String,
            question: String,
            path: String,
            content: String,
            requiredFactGroups: [[String]],
            forbiddenAnswerPatterns: [String] = [],
            expectsInsufficient: Bool = false
        ) {
            self.name = name
            self.question = question
            self.path = path
            self.content = content
            self.requiredFactGroups = requiredFactGroups
            self.forbiddenAnswerPatterns = forbiddenAnswerPatterns
            self.expectsInsufficient = expectsInsufficient
        }
    }

    @Test
    func productionRouterRoutesConversationAndBuildsStableSearchPlans() async throws {
        let environment = ProcessInfo.processInfo.environment
        guard environment["KINIC_RUN_LIVE_AI_EVAL"] == "1" else {
            print("Ask AI live evaluation skipped; set KINIC_RUN_LIVE_AI_EVAL=1 to run it.")
            return
        }

        let repetitions = max(1, Int(environment["KINIC_LIVE_AI_REPETITIONS"] ?? "3") ?? 3)
        let endpoint = try #require(URL(string: environment["KINIC_ASK_AI_URL"] ?? "https://api.kinic.io/chat"))
        let client = AskAIClient(endpoint: endpoint)
        let cases = evaluationCases
        var completedRuns = 0
        var parseFailures = 0
        var routeMismatches = 0
        var searchRuns = 0
        var minimumTwoQuerySearchRuns = 0
        var atLeastThreeQuerySearchRuns = 0
        var anchorPreservingSearchRuns = 0
        var routeByCase: [String: [String]] = [:]
        var queriesByCase: [String: [[String]]] = [:]

        for testCase in cases {
            for repetition in 1...repetitions {
                let prompt = AskAIRouter.buildPrompt(
                    databaseTitle: "testDB",
                    question: testCase.question,
                    history: testCase.history
                )
                var response = try await client.completeContent(message: prompt, timeout: .seconds(45))
                completedRuns += 1

                do {
                    var route: AskAIRoute
                    var needsRepair = false
                    do {
                        route = try AskAIRouter.parse(response)
                        if case .conversation = route,
                           AskAIRouter.requiresDatabaseSearch(
                            question: testCase.question,
                            history: testCase.history
                           ) {
                            needsRepair = true
                        }
                        if case .search = route,
                           AskAIRouter.requiresConversation(question: testCase.question) {
                            needsRepair = true
                        }
                    } catch is AskAIRouteError {
                        route = .conversation(answer: "")
                        needsRepair = true
                    }
                    if needsRepair {
                        response = try await client.completeContent(
                            message: AskAIRouter.buildRepairPrompt(
                                databaseTitle: "testDB",
                                question: testCase.question,
                                history: testCase.history
                            ),
                            timeout: .seconds(45)
                        )
                        route = try AskAIRouter.parse(response)
                    }
                    switch route {
                    case let .conversation(answer):
                        routeByCase[testCase.name, default: []].append(ExpectedRoute.conversation.rawValue)
                        if testCase.expectedRoute != .conversation {
                            routeMismatches += 1
                        }
                        #expect(!answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    case let .search(parsedPlan):
                        let plan = AskAIQueryPlanner.enriched(
                            parsedPlan,
                            question: testCase.question,
                            history: testCase.history
                        )
                        routeByCase[testCase.name, default: []].append(ExpectedRoute.search.rawValue)
                        queriesByCase[testCase.name, default: []].append(plan.queries.map(\.text))
                        searchRuns += 1
                        if testCase.expectedRoute != .search {
                            routeMismatches += 1
                        }
                        if plan.queries.count >= AskAIQueryPlanner.maximumGeneratedQueries {
                            atLeastThreeQuerySearchRuns += 1
                        }
                        if plan.queries.count >= 2 {
                            minimumTwoQuerySearchRuns += 1
                        }
                        if let anchor = testCase.requiredSearchAnchor,
                           plan.queries.contains(where: { $0.text.localizedCaseInsensitiveContains(anchor) }) {
                            anchorPreservingSearchRuns += 1
                        }
                    }
                } catch {
                    parseFailures += 1
                    routeByCase[testCase.name, default: []].append("parse-failure")
                    print("Ask AI live parse failure [\(testCase.name) run \(repetition)]: \(response)")
                }
            }
        }

        let expectedSearchRuns = cases.filter { $0.expectedRoute == .search }.count * repetitions
        let stableCaseCount = routeByCase.values.filter { Set($0).count == 1 }.count
        print("Ask AI live evaluation: runs=\(completedRuns), parse_failures=\(parseFailures), route_mismatches=\(routeMismatches), stable_cases=\(stableCaseCount)/\(cases.count), minimum_two_query_search_runs=\(minimumTwoQuerySearchRuns)/\(expectedSearchRuns), at_least_three_query_search_runs=\(atLeastThreeQuerySearchRuns)/\(expectedSearchRuns), anchor_preserving_search_runs=\(anchorPreservingSearchRuns)/\(expectedSearchRuns)")
        for testCase in cases {
            print("Ask AI live case [\(testCase.name)]: routes=\(routeByCase[testCase.name, default: []]), queries=\(queriesByCase[testCase.name, default: []])")
        }

        #expect(completedRuns == cases.count * repetitions)
        #expect(parseFailures == 0)
        #expect(routeMismatches == 0)
        #expect(stableCaseCount == cases.count)
        #expect(searchRuns == expectedSearchRuns)
        #expect(minimumTwoQuerySearchRuns == expectedSearchRuns)
        #expect(anchorPreservingSearchRuns == expectedSearchRuns)
    }

    @Test
    func productionAnswersRemainGroundedInRepresentativeEvidence() async throws {
        let environment = ProcessInfo.processInfo.environment
        guard environment["KINIC_RUN_LIVE_AI_EVAL"] == "1" else {
            print("Ask AI live answer evaluation skipped; set KINIC_RUN_LIVE_AI_EVAL=1 to run it.")
            return
        }

        let repetitions = max(1, Int(environment["KINIC_LIVE_AI_REPETITIONS"] ?? "3") ?? 3)
        let endpoint = try #require(URL(string: environment["KINIC_ASK_AI_URL"] ?? "https://api.kinic.io/chat"))
        let client = AskAIClient(endpoint: endpoint)
        var completedRuns = 0
        var insufficientAnswers = 0
        var citationFailures = 0
        var factFailures = 0

        for testCase in groundedAnswerCases {
            let source = AskAIContextSource(
                source: AskAISource(
                    id: "S1",
                    path: testCase.path,
                    excerpt: String(testCase.content.prefix(300)),
                    score: -1,
                    matchReasons: ["content_fts"]
                ),
                content: testCase.content
            )
            let prompt = AskAIPromptBuilder.build(
                databaseTitle: "testDB",
                question: testCase.question,
                history: [],
                sources: [source]
            )

            for repetition in 1...repetitions {
                if AskAIIdentityPolicy.requiresExplicitEvidence(question: testCase.question),
                   !AskAIIdentityPolicy.hasDirectEvidence(
                    question: testCase.question,
                    sources: [source]
                   ) {
                    completedRuns += 1
                    if testCase.expectsInsufficient {
                        print("Ask AI live identity policy rejected unsupported answer [\(testCase.name) run \(repetition)]")
                    } else {
                        insufficientAnswers += 1
                    }
                    continue
                }
                let response = try await client.completeContent(message: prompt.message, timeout: .seconds(60))
                completedRuns += 1
                switch try AskAIResponseDecoder.decode(response, validSourceIDs: ["S1"]) {
                case .insufficient:
                    if testCase.expectsInsufficient {
                        print("Ask AI live expected insufficient answer [\(testCase.name) run \(repetition)]")
                    } else {
                        insufficientAnswers += 1
                        print("Ask AI live insufficient answer [\(testCase.name) run \(repetition)]")
                    }
                case let .supported(sourceIDs, answer):
                    if testCase.expectsInsufficient {
                        factFailures += 1
                        print("Ask AI live expected insufficient but received answer [\(testCase.name) run \(repetition)]: \(answer)")
                        continue
                    }
                    if sourceIDs != ["S1"] {
                        citationFailures += 1
                    }
                    let normalizedAnswer = answer.precomposedStringWithCompatibilityMapping.lowercased()
                    let missingFactGroups = testCase.requiredFactGroups.filter { alternatives in
                        !alternatives.contains { alternative in
                            normalizedAnswer.contains(alternative.precomposedStringWithCompatibilityMapping.lowercased())
                        }
                    }
                    if !missingFactGroups.isEmpty {
                        factFailures += 1
                        print("Ask AI live fact failure [\(testCase.name) run \(repetition)]: missing=\(missingFactGroups), answer=\(answer)")
                    }
                    let forbiddenPatterns = testCase.forbiddenAnswerPatterns.filter { pattern in
                        answer.range(of: pattern, options: .regularExpression) != nil
                    }
                    if !forbiddenPatterns.isEmpty {
                        factFailures += 1
                        print("Ask AI live attribution failure [\(testCase.name) run \(repetition)]: patterns=\(forbiddenPatterns), answer=\(answer)")
                    }
                }
            }
        }

        let expectedRuns = groundedAnswerCases.count * repetitions
        print("Ask AI live answer evaluation: runs=\(completedRuns)/\(expectedRuns), insufficient=\(insufficientAnswers), citation_failures=\(citationFailures), fact_failures=\(factFailures)")
        #expect(completedRuns == expectedRuns)
        #expect(insufficientAnswers == 0)
        #expect(citationFailures == 0)
        #expect(factFailures == 0)
    }

    private var evaluationCases: [EvaluationCase] {
        [
            EvaluationCase(
                name: "greeting",
                question: "こんにちは。今日もよろしく。",
                history: [],
                expectedRoute: .conversation,
                requiredSearchAnchor: nil
            ),
            EvaluationCase(
                name: "translation",
                question: "次の文を自然な英語にして: 会議は明日の午後3時です。",
                history: [],
                expectedRoute: .conversation,
                requiredSearchAnchor: nil
            ),
            EvaluationCase(
                name: "brainstorming",
                question: "新商品の短いキャッチコピーを3案考えて。",
                history: [],
                expectedRoute: .conversation,
                requiredSearchAnchor: nil
            ),
            EvaluationCase(
                name: "history_rewrite",
                question: "もっと短くして。",
                history: [
                    AskAIMessage(role: .user, text: "丁寧な会議案内を書いて"),
                    AskAIMessage(role: .assistant, text: "明日の午後3時より会議を開催いたします。ご参加ください。")
                ],
                expectedRoute: .conversation,
                requiredSearchAnchor: nil
            ),
            EvaluationCase(
                name: "missing_referent",
                question: "この文章を要約して。",
                history: [],
                expectedRoute: .conversation,
                requiredSearchAnchor: nil
            ),
            EvaluationCase(
                name: "precious_metals_edge",
                question: "貴金属の鞘について教えて。",
                history: [],
                expectedRoute: .search,
                requiredSearchAnchor: "貴金属"
            ),
            EvaluationCase(
                name: "x402_notes",
                question: "私のノートにあるx402の有料APIルートを教えて。",
                history: [],
                expectedRoute: .search,
                requiredSearchAnchor: "x402"
            ),
            EvaluationCase(
                name: "taalas_investment",
                question: "Taalasへの投資判断をノートから確認して。",
                history: [],
                expectedRoute: .search,
                requiredSearchAnchor: "taalas"
            ),
            EvaluationCase(
                name: "khao_man_gai",
                question: "カオマンガイの材料はデータベースに何と書いてある？",
                history: [],
                expectedRoute: .search,
                requiredSearchAnchor: "カオマンガイ"
            ),
            EvaluationCase(
                name: "web_release_checklist",
                question: "前に記録したWebサービス公開前チェックを教えて。",
                history: [],
                expectedRoute: .search,
                requiredSearchAnchor: "web"
            ),
            EvaluationCase(
                name: "pre_design_exact",
                question: "pre-design-mdって何ができるツール？",
                history: [],
                expectedRoute: .search,
                requiredSearchAnchor: "pre-design-md"
            ),
            EvaluationCase(
                name: "pre_design_followup",
                question: "例のツールの5ステップ全部と4つの出力形式をまとめて。",
                history: [
                    AskAIMessage(role: .user, text: "pre-design-mdについて教えて"),
                    AskAIMessage(role: .assistant, text: "デザインの土台を決めるツールです。")
                ],
                expectedRoute: .search,
                requiredSearchAnchor: "pre-design-md"
            ),
            EvaluationCase(
                name: "pre_design_identity_followup",
                question: "それを作ったのは俺だと言える？",
                history: [
                    AskAIMessage(role: .user, text: "pre-design-mdについて教えて"),
                    AskAIMessage(role: .assistant, text: "デザインの土台を決めるツールです。")
                ],
                expectedRoute: .search,
                requiredSearchAnchor: "pre-design-md"
            )
        ]
    }

    private var groundedAnswerCases: [GroundedAnswerCase] {
        [
            GroundedAnswerCase(
                name: "x402_routes",
                question: "ノートにあるx402の有料APIルートを教えて。",
                path: "/Wiki/tech/icp/x402-paid-api-route-catalog-audit-log.md",
                content: """
                # x402 Paid API Route Catalog and Audit Log Enhancement
                This refactors the x402 paid API example into a route catalog pattern, with separate pricing per endpoint for `/paid/report` and `/paid/outcall`, structured PAYMENT-SIGNATURE handling with product metadata, and `/free/catalog` returning a products array. `/paid/report` and `/paid/outcall` each handle individual `price` and `payTo` values.
                """,
                requiredFactGroups: [["/paid/report"], ["/paid/outcall"]]
            ),
            GroundedAnswerCase(
                name: "taalas_funding",
                question: "ノートに記録されたTaalasの直近と累計の調達額を教えて。",
                path: "/Wiki/investing/ai-chips/toushisen-no-sentei.md",
                content: """
                # 投資先の選定
                Taalasのような特化型AIチップに焦点を当てた投資候補を整理している。Taalasは2026年2月に1.69億ドルを調達、累計調達額は2.19億ドル。未解決の疑問は、Taalasの二次流通やSPVに参加する具体的な方法。
                """,
                requiredFactGroups: [["1.69億", "$169"], ["2.19億", "$219"]]
            ),
            GroundedAnswerCase(
                name: "khao_man_gai_ingredients",
                question: "カオマンガイの主な材料を教えて。",
                path: "/Wiki/recipes/easy-khao-man-gai-recipe-ajinomoto.md",
                content: """
                # 簡単カオマンガイのレシピ（Cook Do 香味ペースト使用）
                4人分の材料は米2合、鶏むね肉2枚（360g）、Cook Do 香味ペースト（鶏肉用6cm、米用12cm）、長ねぎ1/2本（50g）、しょうが1かけ（12g）、水、こしょう。好みでレタス、トマト、きゅうりを添える。
                """,
                requiredFactGroups: [["米", "rice"], ["鶏", "chicken"], ["香味ペースト", "flavor paste", "cook do"]]
            ),
            GroundedAnswerCase(
                name: "web_release_checklist",
                question: "Webサービス公開前チェックの主な領域を教えて。",
                path: "/Wiki/tech/web/web-service-checklist.md",
                content: """
                # Webサービス公開前のチェックリスト
                セキュリティ、ログイン、メール送信、SEO、OGP、決済、アクセシビリティ、パフォーマンス、複数環境での動作確認をカバーする。Cookie属性、入力値検証、セキュリティヘッダ、SPF/DKIM/DMARC、titleとcanonical URL、OGP、重複決済防止、alt属性などを確認する。
                """,
                requiredFactGroups: [["セキュリティ", "security"], ["seo"], ["決済", "payment"]]
            ),
            GroundedAnswerCase(
                name: "pre_design_features",
                question: "pre-design-mdの5ステップと4つの出力形式を全部教えて。",
                path: "/Knowledge/conversations/pre-design-md.md",
                content: """
                pre-design-mdは、フォント、余白、角丸、影、色の5ステップでデザインの土台を視覚的に組み立て、Google DESIGN.md、Rich Prompt、CSS Variables、Figma Tokensの4フォーマットで出力する。日本語にも対応している。
                """,
                requiredFactGroups: [
                    ["フォント"], ["余白"], ["角丸"], ["影"], ["色"],
                    ["google design.md"], ["rich prompt"], ["css variables"], ["figma tokens"]
                ]
            ),
            GroundedAnswerCase(
                name: "pre_design_saved_article",
                question: "俺が保存したpre-design-mdの記事、何を作った話だっけ？",
                path: "/Knowledge/conversations/pre-design-md.md",
                content: """
                pre-design-mdは、AIにUI生成を任せる前に、人間がフォント、余白、角丸、影、色の基礎値を自分で決めるためのツール。
                """,
                requiredFactGroups: [["デザイン", "ui"]],
                forbiddenAnswerPatterns: ["あなた.{0,20}(作った|作成|開発)"]
            ),
            GroundedAnswerCase(
                name: "pre_design_personal_identity",
                question: "この記事から分かる俺の本名と勤務先を教えて。",
                path: "/Knowledge/conversations/pre-design-md.md",
                content: "pre-design-mdはフォント、余白、角丸、影、色からデザインの土台を作るツール。",
                requiredFactGroups: [],
                expectsInsufficient: true
            ),
            GroundedAnswerCase(
                name: "pre_design_ownership",
                question: "このDBの持ち主がpre-design-mdを開発した本人だと言える？",
                path: "/Knowledge/conversations/pre-design-md.md",
                content: "pre-design-mdはフォント、余白、角丸、影、色からデザインの土台を作るツール。",
                requiredFactGroups: [],
                expectsInsufficient: true
            )
        ]
    }
}
