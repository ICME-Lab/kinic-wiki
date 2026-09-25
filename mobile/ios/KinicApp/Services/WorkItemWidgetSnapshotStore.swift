// Where: mobile/ios/KinicApp/Services/WorkItemWidgetSnapshotStore.swift
// What: App Group JSON read/write for the widget snapshot.
// Why: The widget process can only read a written file, so the app owns every mutation.

import Foundation

struct WorkItemWidgetSnapshotStore: @unchecked Sendable {
    static let fileName = "widget-snapshot.v1.json"

    private let directory: URL?
    private let fileManager: FileManager

    /// Resolves the App Group container. Without a configured group the store is inert.
    init(appGroupId: String?, fileManager: FileManager = .default) {
        self.fileManager = fileManager
        guard let appGroupId,
              !appGroupId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let container = fileManager.containerURL(forSecurityApplicationGroupIdentifier: appGroupId) else {
            directory = nil
            return
        }
        directory = container.appending(path: "WorkItems", directoryHint: .isDirectory)
    }

    init(directory: URL, fileManager: FileManager = .default) {
        self.fileManager = fileManager
        self.directory = directory
    }

    var isConfigured: Bool { directory != nil }

    /// Returns `nil` for a missing file and for a version this build does not understand.
    func read() -> WorkItemWidgetSnapshot? {
        guard let fileURL = fileURL,
              let data = try? Data(contentsOf: fileURL),
              let snapshot = try? JSONDecoder().decode(WorkItemWidgetSnapshot.self, from: data),
              snapshot.version == WorkItemWidgetSnapshot.currentVersion else {
            return nil
        }
        return snapshot
    }

    func write(_ snapshot: WorkItemWidgetSnapshot) throws {
        guard let directory, let fileURL = fileURL else { return }
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        let data = try JSONEncoder().encode(snapshot.sanitized())
        let temporaryURL = directory.appending(path: "\(Self.fileName).tmp")
        try data.write(to: temporaryURL, options: .atomic)
        if fileManager.fileExists(atPath: fileURL.path) {
            _ = try fileManager.replaceItemAt(fileURL, withItemAt: temporaryURL)
        } else {
            try fileManager.moveItem(at: temporaryURL, to: fileURL)
        }
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var mutableURL = fileURL
        try? mutableURL.setResourceValues(values)
    }

    func clear() {
        guard let fileURL else { return }
        try? fileManager.removeItem(at: fileURL)
    }

    private var fileURL: URL? {
        directory?.appending(path: Self.fileName)
    }
}
