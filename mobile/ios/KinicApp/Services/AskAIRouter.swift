// Where: mobile/ios/KinicApp/Services/AskAIRouter.swift
// What: Routes a user turn to either a direct conversational answer or a bounded database search plan.
// Why: Transformations and ordinary conversation must not be misinterpreted as note searches.

import Foundation

enum AskAIRoute: Equatable, Sendable {
    case conversation(answer: String)
    case search(plan: AskAIQueryPlan)
}

enum AskAIRouter {
    static let maximumQuestionCharacters = AskAIQueryPlanner.maximumQuestionCharacters
    static let maximumHistoryCharacters = 6_000

    static func buildPrompt(
        databaseTitle: String,
        question: String,
        history: [AskAIMessage]
    ) -> String {
        let recentHistory = AskAIHistoryFormatter.format(
            history,
            maximumCharacters: maximumHistoryCharacters
        )
        let boundedQuestion = question.boundedAskAIRouteText(to: maximumQuestionCharacters)
        let database = databaseTitle.isEmpty ? "(none selected)" : databaseTitle
        let requiredMode: String
        if requiresDatabaseSearch(question: question, history: history) {
            requiredMode = "search — this request requires evidence from the selected database"
        } else if requiresConversation(question: question) {
            requiredMode = "conversation — this is an explicit transformation or translation request"
        } else {
            requiredMode = "not predetermined — apply the rules below"
        }

        return """
        REQUEST ROUTER AND CONVERSATIONAL RESPONDER
        Decide whether CURRENT QUESTION can be answered as conversation or requires searching the user's selected note database.
        REQUIRED MODE: \(requiredMode)

        Choose conversation for translation, summarization, rewriting, drafting, brainstorming, greetings, and ordinary dialogue that can be completed from CURRENT QUESTION and RECENT CONVERSATION. A request to transform or shorten a previous answer is conversation. Resolve omitted subjects such as "translate this" from RECENT CONVERSATION. If the requested content is missing for a transformation, ask the user for it instead of searching, unless CURRENT QUESTION explicitly refers to the selected database, its notes, or saved sources.

        Choose search when the user asks about their database, notes, sources, recorded facts, personal facts recorded in the database, or asks a factual question that requires external information or verification. A transformation that explicitly targets the selected database, its notes, or saved sources also requires search. A factual follow-up requires search even when RECENT CONVERSATION identifies its topic. RECENT CONVERSATION may resolve what "it", "that tool", "the example", or an omitted subject refers to, but an earlier assistant answer is never database evidence for a newly requested fact. A request to explain a named topic or noun phrase, including an unfamiliar or ambiguous term, requires search. Do not ask for clarification merely because the named topic is unfamiliar. Do not answer such questions from general knowledge.

        For conversation, answer the user now and use the language they request or use.

        For search, always write exactly 3 distinct search-query lines. Write them in this order:
        1. A literal query that preserves identifiers, proper nouns, and key nouns from CURRENT QUESTION. If CURRENT QUESTION uses a pronoun, definite reference, or omitted topic, copy the resolved distinctive identifier or proper noun from RECENT CONVERSATION into this query.
        2. A paraphrase that keeps the most distinctive anchor term but replaces one other concept with a synonym or domain wording likely to appear in the notes.
        3. An anchor query containing only the 1 or 2 most distinctive identifiers, proper nouns, or key nouns, including a referent resolved from RECENT CONVERSATION when needed.

        If a safe synonym is unavailable, make the second and third lines distinct shorter queries by removing different non-anchor terms from the literal query. For a two-term literal query, its individual distinctive terms may be the two shorter queries. Never invent a concept merely to create a line.

        Prefer 1 to 4 space-separated terms per query. Up to 8 is valid when needed; count whitespace-separated terms before output and never write 9 or more. Use the same language and script as CURRENT QUESTION for concept terms; do not translate Japanese concepts into English. Preserve the original spelling and script of identifiers and proper nouns copied from either CURRENT QUESTION or RECENT CONVERSATION. Changing only term order is a duplicate. Never use a generic request word such as question, information, explain, tell, note, or database as the anchor. Do not invent a person, product, identifier, or factual claim. Do not include the selected database name as a search term.

        Output exactly one of these structures and nothing else:
        <mode>conversation</mode>
        <answer>DIRECT ANSWER</answer>

        <mode>search</mode>
        <answer>first query
        second query
        third query</answer>

        The words "first query", "second query", and "third query" only show line positions. Replace them with actual query terms. Never output a heading or label inside <answer>. Always close the answer with </answer>.

        Selected database: \(database)
        RECENT CONVERSATION:
        \(recentHistory.isEmpty ? "(none)" : recentHistory)

        CURRENT QUESTION:
        \(boundedQuestion)
        """
    }

    static func buildRepairPrompt(
        databaseTitle: String,
        question: String,
        history: [AskAIMessage]
    ) -> String {
        let requiredMode: String
        if requiresDatabaseSearch(question: question, history: history) {
            requiredMode = " The corrected response MUST use <mode>search</mode>."
        } else if requiresConversation(question: question) {
            requiredMode = " The corrected response MUST use <mode>conversation</mode>."
        } else {
            requiredMode = ""
        }
        return buildPrompt(databaseTitle: databaseTitle, question: question, history: history) + """


        CORRECTION: Your previous response was invalid or violated REQUIRED MODE. Try once more. Return exactly one of the two allowed <mode>/<answer> structures, close every tag, and include no text outside the tags.\(requiredMode)
        """
    }

    static func requiresDatabaseSearch(
        question: String,
        history: [AskAIMessage]
    ) -> Bool {
        let normalized = question.precomposedStringWithCompatibilityMapping.lowercased()
        if requiresStoredDatabaseEvidence(normalizedQuestion: normalized) {
            return true
        }
        if requiresConversation(question: question) {
            return false
        }

        let identityMarkers = [
            "俺の本名", "私の本名", "勤務先", "職業", "本人", "俺だと言える", "私だと言える",
            "database owner", "db owner", "my employer", "my occupation"
        ]
        if !history.isEmpty, identityMarkers.contains(where: normalized.contains) {
            return true
        }

        guard AskAIQueryPlanner.contextualAnchor(question: question, history: history) != nil else {
            return false
        }
        let factualMarkers = [
            "?", "？", "教えて", "知りたい", "使える", "対応", "何", "どれ", "いつ", "誰",
            "全部", "まとめて", "と言える", "how", "what", "which", "who", "when", "does", "is "
        ]
        return factualMarkers.contains(where: normalized.contains)
    }

    static func requiresConversation(question: String) -> Bool {
        let normalized = question.precomposedStringWithCompatibilityMapping.lowercased()
        guard !requiresStoredDatabaseEvidence(normalizedQuestion: normalized) else {
            return false
        }
        let transformationMarkers = [
            "短くして", "短くまとめて", "書き直", "言い換え", "翻訳", "英語にして", "日本語にして",
            "要約して", "rewrite", "translate", "shorter", "summarize"
        ]
        return transformationMarkers.contains(where: normalized.contains)
    }

    private static func requiresStoredDatabaseEvidence(normalizedQuestion: String) -> Bool {
        let markers = [
            "このdb", "dbの", "db内", "データベース", "ノート", "保存した記事", "保存したページ",
            "保存済みの記事", "保存済みページ", "my database", "this database", "the database",
            "my notes", "saved notes", "database notes", "this note", "the note", "saved article",
            "saved page", "stored article", "stored page", "source note", "source document"
        ]
        return markers.contains(where: normalizedQuestion.contains)
    }

    static func parse(_ response: String) throws -> AskAIRoute {
        guard !response.unicodeScalars.contains(where: { scalar in
            CharacterSet.controlCharacters.contains(scalar) && scalar != "\n" && scalar != "\r"
        }),
        let mode = extract(tag: "mode", from: response),
        let answer = extract(tag: "answer", from: response),
        envelopeContainsOnlyTags(response) else {
            throw AskAIRouteError.invalidFormat
        }

        switch mode.trimmingCharacters(in: .whitespacesAndNewlines) {
        case "conversation":
            let directAnswer = answer.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !directAnswer.isEmpty else { throw AskAIRouteError.invalidFormat }
            return .conversation(answer: directAnswer)
        case "search":
            do {
                return .search(plan: try AskAIQueryPlanner.parse("<answer>\(answer)</answer>"))
            } catch {
                throw AskAIRouteError.invalidFormat
            }
        default:
            throw AskAIRouteError.invalidFormat
        }
    }

    private static func extract(tag: String, from response: String) -> String? {
        let opening = "<\(tag)>"
        let closing = "</\(tag)>"
        guard response.components(separatedBy: opening).count == 2,
              response.components(separatedBy: closing).count == 2,
              let openingRange = response.range(of: opening),
              let closingRange = response.range(of: closing),
              openingRange.upperBound <= closingRange.lowerBound else {
            return nil
        }
        return String(response[openingRange.upperBound..<closingRange.lowerBound])
    }

    private static func envelopeContainsOnlyTags(_ response: String) -> Bool {
        guard let modeStart = response.range(of: "<mode>"),
              let modeEnd = response.range(of: "</mode>"),
              let answerStart = response.range(of: "<answer>"),
              let answerEnd = response.range(of: "</answer>"),
              modeStart.upperBound <= modeEnd.lowerBound,
              modeEnd.upperBound <= answerStart.lowerBound,
              answerStart.upperBound <= answerEnd.lowerBound else {
            return false
        }
        return response[..<modeStart.lowerBound].allSatisfy(\.isWhitespace)
            && response[modeEnd.upperBound..<answerStart.lowerBound].allSatisfy(\.isWhitespace)
            && response[answerEnd.upperBound...].allSatisfy(\.isWhitespace)
    }
}

enum AskAIRouteError: Error, LocalizedError, Equatable {
    case invalidFormat

    var errorDescription: String? {
        "Kinic AI could not determine how to handle that request."
    }
}

private extension String {
    func boundedAskAIRouteText(to limit: Int) -> String {
        guard count > limit else { return self }
        return String(prefix(limit))
    }
}
