import Foundation

struct AssistantCitation: Codable, Identifiable, Sendable {
    let id: String
    let databaseId: String
    let path: String
    let excerpt: String
    let etag: String
}
struct AssistantAnswer: Codable, Sendable {
    let answer: String
    let citations: [AssistantCitation]
    let insufficient: Bool
    let contradictions: [String]
    let unverified: [String]
    var displayText: String {
        var parts = [answer]
        if insufficient { parts.append("根拠が不足しています。") }
        if !contradictions.isEmpty { parts.append("矛盾する情報\n" + contradictions.map { "・" + $0 }.joined(separator: "\n")) }
        if !unverified.isEmpty { parts.append("未検証の情報\n" + unverified.map { "・" + $0 }.joined(separator: "\n")) }
        return parts.joined(separator: "\n\n")
    }
}
struct AssistantMessage: Codable, Identifiable, Sendable {
    let voice: Bool
    let requestId: String
    var id: String { requestId }
    let question: String
    let answer: AssistantAnswer?
    let error: String?
}
struct AssistantUtterance: Codable, Identifiable, Sendable {
    let id: String
    let role: String
    let text: String
}
struct AssistantSnapshot: Codable, Sendable {
    let id: String
    let databaseId: String
    let scope: String
    let status: String
    let error: String?
    let generation: Int
    let reconnectGraceMs: Int
    let messages: [AssistantMessage]
    let utterances: [AssistantUtterance]
    let voice: String
    let voiceDeadline: Double?
    let voiceId: String?
    let progress: Progress?
    struct Progress: Codable, Sendable { let calls: Int; let stage: String }
}
struct AssistantQuote: Codable, Sendable {
    let rateVersion: String
    let cyclesPerMinute: String
    let maximumCycles: String
    let maximumSeconds: Int
}
struct AssistantHTTPError: LocalizedError {
    let status: Int
    let code: String
    var terminal: Bool { [401, 403, 404, 410].contains(status) || code == "assistant_disabled" }
    var errorDescription: String? {
        switch code {
        case "assistant_disabled": "音声対話は現在利用できません。"
        case "assistant_not_configured": "音声サービスの設定が完了していません。"
        case "voice_permission_required": "音声が無効です。所有者は音声設定で有効にしてください。メンバーは所有者の許可が必要です。"
        case "database_access_denied": "このデータベースの閲覧権限がありません。"
        case "kinic_session_expired": "ログインの有効期限が切れました。再ログインしてください。"
        case "choose_questions_only", "invalid_delegation", "invalid_delegation_key", "invalid_delegation_target", "invalid_delegation_expiry": "閲覧権限を確認できませんでした。再ログインしてお試しください。"
        case "identity_changed": "Wikiにログインしたものと同じアカウントを使用してください。"
        case "voice_connection_failed": "音声に接続できませんでした。通信状態を確認して再試行してください。"
        case "voice_close_pending": "音声を停止しています。文字の回答は引き続き受信します。"
        case "microphone_denied": "マイクを使用できません。iPhoneの設定でマイクを許可してください。"
        case "voice_billing_not_configured": "音声料金がまだ設定されていません。"
        case "voice_price_consent_required": "料金が変更されました。再試行して新しい料金をご確認ください。"
        case "authentication_required": "音声の認証が切れました。接続し直してください。"
        case "voice_budget_exhausted": "本日の音声予算に達しました。音声設定で上限を変更できます。"
        case "voice_balance_insufficient": "データベースのcycles残高が不足しています。"
        case "voice_billing_denied": "音声の利用条件を確認できませんでした。設定を確認してください。"
        case "voice_context_limit": "会話が長くなったため音声を停止しました。履歴を保存して新しい会話を始めてください。"
        case "rate_limit": "接続回数の上限に達しました。少し待って再試行してください。"
        default: "音声の処理に失敗しました。再試行してください。"
        }
    }
}

/// Keep the complete JSON request below the Worker's 64 KiB body limit,
/// including multi-byte text and JSON escaping. The smaller context budget
/// also fits Live's 16,384-token startup instruction limit.
enum AssistantHistoryContext {
    static func make(_ messages: [AskAIMessage]) -> [[String: String]] {
        var result: [[String: String]] = []
        for message in messages.suffix(20).reversed() {
            guard !message.text.isEmpty else { continue }
            let characters = Array(message.text.prefix(4000))
            let role = message.role == .user ? "user" : "assistant"
            var lower = 0, upper = characters.count
            // The Worker counts UTF-16 code units; JSON also has a total byte
            // limit. Keep the largest whole-character prefix satisfying both.
            while lower < upper {
                let middle = (lower + upper + 1) / 2
                let text = String(characters.prefix(middle))
                let candidate = [["role": role, "text": text]] + result
                if text.utf16.count <= 4000,
                   let data = try? JSONSerialization.data(withJSONObject: candidate), data.count <= 12000 {
                    lower = middle
                } else { upper = middle - 1 }
            }
            guard lower > 0 else { break }
            result.insert(["role": role, "text": String(characters.prefix(lower))], at: 0)
        }
        return result
    }
}

/// A stop acknowledgement is not a finalized transcript. Poll only until the
/// server has persisted the final voice state; the caller then saves and logs out.
@MainActor
enum AssistantVoiceFinalization {
    static func waitForStop(
        conversationID: String, databaseID: String,
        now: () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
        pause: () async throws -> Void = { try await Task.sleep(for: .seconds(1)) },
        fetch: (TimeInterval) async throws -> AssistantSnapshot
    ) async throws -> AssistantSnapshot {
        let deadline = now() + 30
        while true {
            try Task.checkCancellation()
            let remaining = deadline - now()
            guard remaining > 0 else { throw URLError(.timedOut) }
            let snapshot = try await fetch(remaining)
            guard snapshot.id == conversationID, snapshot.databaseId == databaseID else { throw URLError(.cannotParseResponse) }
            if snapshot.voice == "off" { return snapshot }
            guard deadline - now() >= 1 else { throw URLError(.timedOut) }
            try await pause()
        }
    }
}
