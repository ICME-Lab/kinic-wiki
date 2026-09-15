import Foundation

/// Temporary preview recovery data, separate from the existing QA history.
struct AssistantConversationCache {
    struct Entry: Codable {
        let principal: String
        let snapshot: AssistantSnapshot
    }
    let directory: URL
    init(directory: URL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appending(path: "VoicePreviewCache", directoryHint: .isDirectory)) {
        self.directory = directory
    }
    private var file: URL { directory.appending(path: "conversation.json") }
    func load() throws -> Entry? {
        guard FileManager.default.fileExists(atPath: file.path) else { return nil }
        return try JSONDecoder().decode(Entry.self, from: Data(contentsOf: file))
    }
    func save(principal: String, snapshot: AssistantSnapshot) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        var url = directory
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try url.setResourceValues(values)
        try JSONEncoder().encode(Entry(principal: principal, snapshot: snapshot)).write(to: file,
            options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
    func clear() throws {
        if FileManager.default.fileExists(atPath: directory.path) { try FileManager.default.removeItem(at: directory) }
    }
}
