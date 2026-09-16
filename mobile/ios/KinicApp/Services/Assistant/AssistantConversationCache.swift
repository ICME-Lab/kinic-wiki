import Foundation

/// Temporary preview recovery data, separate from the existing QA history.
struct AssistantConversationCache {
    struct Entry: Codable {
        let principal: String
        let snapshot: AssistantSnapshot
        let conversationID: UUID
        let databaseTitle: String
    }
    let directory: URL
    init(directory: URL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appending(path: "VoicePreviewCache", directoryHint: .isDirectory)) {
        self.directory = directory
    }
    private var file: URL { directory.appending(path: "conversation-v2.json") }
    func load() throws -> Entry? {
        guard FileManager.default.fileExists(atPath: file.path) else { return nil }
        return try JSONDecoder().decode(Entry.self, from: Data(contentsOf: file))
    }
    func save(principal: String, snapshot: AssistantSnapshot, conversationID: UUID, databaseTitle: String) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        var url = directory
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try url.setResourceValues(values)
        try JSONEncoder().encode(Entry(principal: principal, snapshot: snapshot, conversationID: conversationID, databaseTitle: databaseTitle)).write(to: file,
            options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
    func markEnding(conversationID: UUID) throws {
        try Data(conversationID.uuidString.utf8).write(to: directory.appending(path: "ending"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
    func isEnding(conversationID: UUID) throws -> Bool {
        let marker = directory.appending(path: "ending")
        guard FileManager.default.fileExists(atPath: marker.path) else { return false }
        return try String(contentsOf: marker, encoding: .utf8) == conversationID.uuidString
    }
    func clear() throws {
        if FileManager.default.fileExists(atPath: directory.path) { try FileManager.default.removeItem(at: directory) }
    }
}
