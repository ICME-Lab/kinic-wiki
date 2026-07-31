// Where: mobile/ios/KinicApp/Models/AskAIHistoryScope.swift
// What: Privacy-safe on-device namespace for Ask AI conversation history.
// Why: Conversation history must never cross authenticated principal boundaries.

import CryptoKit
import Foundation

enum AskAIHistoryScope: Hashable, Sendable {
    case guest
    case authenticated(principalHash: String)

    init(principal: String?) {
        guard let principal, !principal.isEmpty else {
            self = .guest
            return
        }
        let digest = SHA256.hash(data: Data(principal.utf8))
        self = .authenticated(principalHash: digest.map { String(format: "%02x", $0) }.joined())
    }

    var directoryName: String {
        switch self {
        case .guest:
            "guest"
        case let .authenticated(principalHash):
            "principal-\(principalHash)"
        }
    }
}
