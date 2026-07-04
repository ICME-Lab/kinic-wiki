// Where: mobile/ios/KinicApp/Services/SourceCaptureTriggerQueue.swift
// What: File-backed queue of source-capture worker triggers.
// Why: Triggering is retryable work that should not block share completion.

import Foundation

struct SourceCaptureTriggerQueue: @unchecked Sendable {
    private static let queueDirectoryName = "pending-source-capture-triggers.v1"
    private let queueDirectory: URL
    private let fileManager: FileManager
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    init(appGroupId: String?, strict: Bool = false, fileManager: FileManager = .default) throws {
        self.fileManager = fileManager
        queueDirectory = try Self.queueDirectory(appGroupId: appGroupId, strict: strict, fileManager: fileManager)
        try fileManager.createDirectory(at: queueDirectory, withIntermediateDirectories: true)
    }

    init(strictAppGroupId appGroupId: String?) throws {
        try self.init(appGroupId: appGroupId, strict: true)
    }

    init(testQueueDirectory: URL, fileManager: FileManager = .default) throws {
        self.fileManager = fileManager
        queueDirectory = testQueueDirectory
        try fileManager.createDirectory(at: queueDirectory, withIntermediateDirectories: true)
    }

    func loadPendingTriggers() -> [PendingSourceCaptureTrigger] {
        let files = (try? fileManager.contentsOfDirectory(
            at: queueDirectory,
            includingPropertiesForKeys: nil
        )) ?? []
        return files
            .filter { $0.pathExtension == "json" }
            .compactMap { fileURL -> PendingSourceCaptureTrigger? in
                guard let data = try? Data(contentsOf: fileURL),
                      let record = try? decoder.decode(SourceCaptureTriggerRecord.self, from: data),
                      let url = URL(string: record.url) else {
                    return nil
                }
                return PendingSourceCaptureTrigger(
                    id: record.requestId,
                    databaseId: record.databaseId,
                    requestPath: record.requestPath,
                    requestId: record.requestId,
                    url: url,
                    createdAt: record.createdAt,
                    lastError: record.lastError
                )
            }
            .sorted { left, right in
                if left.createdAt == right.createdAt {
                    left.requestId < right.requestId
                } else {
                    left.createdAt < right.createdAt
                }
            }
    }

    func enqueue(_ request: SourceCaptureRequest, createdAt: Date = .now, lastError: String? = nil) throws {
        try write(
            SourceCaptureTriggerRecord(
                databaseId: request.databaseId,
                requestPath: request.requestPath,
                requestId: request.requestId,
                url: request.normalizedURL.absoluteString,
                createdAt: createdAt,
                lastError: lastError
            )
        )
    }

    func updateFailure(_ trigger: PendingSourceCaptureTrigger, error: String) {
        try? write(
            SourceCaptureTriggerRecord(
                databaseId: trigger.databaseId,
                requestPath: trigger.requestPath,
                requestId: trigger.requestId,
                url: trigger.url.absoluteString,
                createdAt: trigger.createdAt,
                lastError: error
            )
        )
    }

    func remove(_ trigger: PendingSourceCaptureTrigger) {
        let fileURL = queueDirectory.appending(path: "\(trigger.requestId).json")
        try? fileManager.removeItem(at: fileURL)
    }

    private func write(_ record: SourceCaptureTriggerRecord) throws {
        let data = try encoder.encode(record)
        let temporaryURL = queueDirectory.appending(path: "\(record.requestId).tmp")
        let finalURL = queueDirectory.appending(path: "\(record.requestId).json")
        try data.write(to: temporaryURL, options: .atomic)
        if fileManager.fileExists(atPath: finalURL.path) {
            try fileManager.removeItem(at: finalURL)
        }
        try fileManager.moveItem(at: temporaryURL, to: finalURL)
    }

    private static func queueDirectory(appGroupId: String?, strict: Bool, fileManager: FileManager) throws -> URL {
        guard let appGroupId,
              !appGroupId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            if strict {
                throw ShareInboxError.missingAppGroupId
            }
            return fileManager.temporaryDirectory.appending(path: "kinic-source-capture-trigger-preview").appending(path: queueDirectoryName)
        }
        guard let containerURL = fileManager.containerURL(forSecurityApplicationGroupIdentifier: appGroupId) else {
            if strict {
                throw ShareInboxError.unavailableAppGroup(appGroupId)
            }
            return fileManager.temporaryDirectory
                .appending(path: "kinic-source-capture-trigger-\(appGroupId)")
                .appending(path: queueDirectoryName)
        }
        return containerURL.appending(path: queueDirectoryName)
    }
}
