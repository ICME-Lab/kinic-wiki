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

    @Test
    func isolatesAuthenticatedPrincipalsAndGuestHistory() async throws {
        let baseDirectory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: baseDirectory) }
        let principalA = "aaaaa-aa"
        let principalB = "bbbbb-bb"
        let storeA = AskAIConversationStore(
            scope: AskAIHistoryScope(principal: principalA),
            baseDirectory: baseDirectory
        )
        let storeB = AskAIConversationStore(
            scope: AskAIHistoryScope(principal: principalB),
            baseDirectory: baseDirectory
        )
        let guestStore = AskAIConversationStore(scope: .guest, baseDirectory: baseDirectory)
        let conversation = AskAIConversation(databaseId: "db_a", databaseTitle: "A")

        try await storeA.save([conversation])

        #expect(try await storeA.load().map(\.id) == [conversation.id])
        #expect(try await storeB.load().isEmpty)
        #expect(try await guestStore.load().isEmpty)
        #expect(!storeA.fileURL.path().contains(principalA))
        #expect(!storeB.fileURL.path().contains(principalB))
        #expect(storeA.fileURL != storeB.fileURL)
        #expect(storeA.fileURL != guestStore.fileURL)
    }

    @Test
    func archivesUnreadableHistoryBeforeResetting() async throws {
        let baseDirectory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: baseDirectory) }
        let store = AskAIConversationStore(scope: .guest, baseDirectory: baseDirectory)
        try FileManager.default.createDirectory(
            at: store.fileURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try Data("not-json".utf8).write(to: store.fileURL)

        do {
            _ = try await store.load()
            Issue.record("Expected unreadable history to fail loading")
        } catch {
            // Expected: reset is only available after a failed read.
        }
        try await store.resetAfterLoadFailure()

        #expect(!FileManager.default.fileExists(atPath: store.fileURL.path()))
        let corruptDirectory = baseDirectory
            .appending(path: "KinicWiki/AskAI/Corrupt", directoryHint: .isDirectory)
        let archivedFiles = try FileManager.default.contentsOfDirectory(
            at: corruptDirectory,
            includingPropertiesForKeys: nil
        )
        #expect(archivedFiles.count == 1)
        #expect(try await store.load().isEmpty)
    }

    private func temporaryDirectory() -> URL {
        FileManager.default.temporaryDirectory
            .appending(path: "ask-ai-store-tests", directoryHint: .isDirectory)
            .appending(path: UUID().uuidString, directoryHint: .isDirectory)
    }
}
