// Where: mobile/ios/KinicTests/AskAIConversationStoreTests.swift
// What: Atomic Ask AI history round-trip tests.
// Why: On-device history must preserve visible evidence metadata without needing full DB documents.

import Foundation
import Testing
@testable import Kinic

struct AskAIConversationStoreTests {
    @Test
    func savesAndLoadsConversationHistory() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appending(path: "ask-ai-store-tests")
            .appending(path: UUID().uuidString)
        let fileURL = directory.appending(path: "history.json")
        defer {
            try? FileManager.default.removeItem(at: directory)
        }
        let store = AskAIConversationStore(fileURL: fileURL)
        let source = AskAISource(
            id: "S1",
            path: "/Knowledge/note.md",
            excerpt: "Short persisted excerpt",
            score: -1,
            matchReasons: ["content_fts"]
        )
        let conversation = AskAIConversation(
            databaseId: "db_test",
            databaseTitle: "Test DB",
            title: "Stored answer",
            messages: [
                AskAIMessage(role: .user, text: "Question"),
                AskAIMessage(role: .assistant, text: "Answer", sources: [source])
            ]
        )

        try await store.save([conversation])
        let loaded = try await store.load()

        #expect(loaded.count == 1)
        #expect(loaded.first?.id == conversation.id)
        #expect(loaded.first?.databaseId == conversation.databaseId)
        #expect(loaded.first?.title == conversation.title)
        #expect(loaded.first?.messages.map(\.text) == conversation.messages.map(\.text))
        #expect(loaded.first?.messages.last?.sources == [source])
        let raw = try String(contentsOf: fileURL, encoding: .utf8)
        #expect(raw.contains("Short persisted excerpt"))
        #expect(!raw.contains("full source body"))
    }
}
