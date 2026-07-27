// Where: mobile/ios/KinicApp/Services/AskAIConversationStore.swift
// What: Versioned, atomic on-device storage for Ask AI conversations.
// Why: Conversation history should survive launches without storing full DB context or using shared defaults.

import Foundation

protocol AskAIConversationPersisting: Sendable {
    func load() async throws -> [AskAIConversation]
    func hasStoredConversationData() async throws -> Bool
    func save(_ conversations: [AskAIConversation]) async throws
    func resetAfterLoadFailure() async throws
    func deleteAllStoredConversationData() async throws
}

actor AskAIConversationStore: AskAIConversationPersisting {
    nonisolated let fileURL: URL
    private let corruptDirectoryURL: URL
    private let decoder: JSONDecoder
    private let encoder: JSONEncoder

    init(fileURL: URL, corruptDirectoryURL: URL? = nil) {
        self.fileURL = fileURL
        self.corruptDirectoryURL = corruptDirectoryURL
            ?? fileURL.deletingLastPathComponent().appending(path: "Corrupt", directoryHint: .isDirectory)
        decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    }

    static func live(scope: AskAIHistoryScope) -> AskAIConversationStore {
        AskAIConversationStore(scope: scope, baseDirectory: .applicationSupportDirectory)
    }

    init(scope: AskAIHistoryScope, baseDirectory: URL) {
        let kinicDirectory = baseDirectory.appending(path: "KinicWiki", directoryHint: .isDirectory)
        let askAIDirectory = kinicDirectory.appending(path: "AskAI", directoryHint: .isDirectory)
        self.init(
            fileURL: askAIDirectory
                .appending(path: scope.directoryName, directoryHint: .isDirectory)
                .appending(path: "conversations-v1.json"),
            corruptDirectoryURL: askAIDirectory.appending(path: "Corrupt", directoryHint: .isDirectory)
        )
    }

    func load() throws -> [AskAIConversation] {
        guard FileManager.default.fileExists(atPath: fileURL.path()) else {
            return []
        }
        return try decoder.decode([AskAIConversation].self, from: Data(contentsOf: fileURL))
            .sorted { $0.updatedAt > $1.updatedAt }
    }

    func hasStoredConversationData() throws -> Bool {
        if FileManager.default.fileExists(atPath: fileURL.path()) {
            return true
        }
        guard FileManager.default.fileExists(atPath: corruptDirectoryURL.path()) else {
            return false
        }
        return try scopedArchiveURLs().isEmpty == false
    }

    func save(_ conversations: [AskAIConversation]) throws {
        let directoryURL = fileURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(
            at: directoryURL,
            withIntermediateDirectories: true
        )
        try excludeFromBackup(directoryURL)
        try encoder.encode(conversations).write(to: fileURL, options: .atomic)
        try excludeFromBackup(fileURL)
    }

    func resetAfterLoadFailure() throws {
        guard FileManager.default.fileExists(atPath: fileURL.path()) else {
            return
        }
        try excludeFromBackup(fileURL)
        try FileManager.default.createDirectory(
            at: corruptDirectoryURL,
            withIntermediateDirectories: true
        )
        try excludeFromBackup(corruptDirectoryURL)
        let timestamp = Int(Date.now.timeIntervalSince1970 * 1_000)
        let namespace = fileURL.deletingLastPathComponent().lastPathComponent
        let archiveURL = corruptDirectoryURL.appending(
            path: "\(namespace)-conversations-v1.corrupt-\(timestamp)-\(UUID().uuidString).json"
        )
        try FileManager.default.moveItem(at: fileURL, to: archiveURL)
        try excludeFromBackup(archiveURL)
    }

    func deleteAllStoredConversationData() throws {
        if FileManager.default.fileExists(atPath: fileURL.path()) {
            try FileManager.default.removeItem(at: fileURL)
        }
        guard FileManager.default.fileExists(atPath: corruptDirectoryURL.path()) else {
            return
        }

        for archiveURL in try scopedArchiveURLs() {
            try FileManager.default.removeItem(at: archiveURL)
        }
    }

    private func scopedArchiveURLs() throws -> [URL] {
        let namespace = fileURL.deletingLastPathComponent().lastPathComponent
        let archivePrefix = "\(namespace)-conversations-v1.corrupt-"
        return try FileManager.default.contentsOfDirectory(
            at: corruptDirectoryURL,
            includingPropertiesForKeys: nil
        ).filter {
            $0.lastPathComponent.hasPrefix(archivePrefix) && $0.pathExtension == "json"
        }
    }

    private func excludeFromBackup(_ url: URL) throws {
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var mutableURL = url
        try mutableURL.setResourceValues(values)
    }
}
