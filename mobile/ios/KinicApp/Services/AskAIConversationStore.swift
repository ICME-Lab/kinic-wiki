// Where: mobile/ios/KinicApp/Services/AskAIConversationStore.swift
// What: Versioned, atomic on-device storage for Ask AI conversations.
// Why: Conversation history should survive launches without storing full DB context or using shared defaults.

import Foundation

protocol AskAIConversationPersisting: Sendable {
    func load() async throws -> [AskAIConversation]
    func save(_ conversations: [AskAIConversation]) async throws
}

actor AskAIConversationStore: AskAIConversationPersisting {
    private let fileURL: URL
    private let decoder: JSONDecoder
    private let encoder: JSONEncoder

    init(fileURL: URL) {
        self.fileURL = fileURL
        decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    }

    static func live() -> AskAIConversationStore {
        let directory = URL.applicationSupportDirectory.appending(path: "KinicWiki", directoryHint: .isDirectory)
        return AskAIConversationStore(fileURL: directory.appending(path: "ask-ai-conversations-v1.json"))
    }

    func load() throws -> [AskAIConversation] {
        guard FileManager.default.fileExists(atPath: fileURL.path()) else {
            return []
        }
        return try decoder.decode([AskAIConversation].self, from: Data(contentsOf: fileURL))
            .sorted { $0.updatedAt > $1.updatedAt }
    }

    func save(_ conversations: [AskAIConversation]) throws {
        try FileManager.default.createDirectory(
            at: fileURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try encoder.encode(conversations).write(to: fileURL, options: .atomic)
    }
}
