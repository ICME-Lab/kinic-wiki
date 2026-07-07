// Where: mobile/ios/KinicApp/Services/ShareInbox.swift
// What: File-backed queue for URLs captured by the Share Extension or manual entry.
// Why: App and extension processes need append/remove operations that do not overwrite each other.

import Foundation

struct ShareInbox: @unchecked Sendable {
    private static let queueDirectoryName = "pending-shared-urls.v2"
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

    func loadPendingURLs() -> [PendingSharedURL] {
        let files = (try? fileManager.contentsOfDirectory(
            at: queueDirectory,
            includingPropertiesForKeys: nil
        )) ?? []
        return files
            .filter { $0.pathExtension == "json" }
            .compactMap { fileURL -> PendingSharedURL? in
                guard let data = try? Data(contentsOf: fileURL),
                      let record = try? decoder.decode(SharedURLRecord.self, from: data),
                      Self.isSafeRecordId(record.id),
                      record.id == fileURL.deletingPathExtension().lastPathComponent,
                      let requestId = try? SourceCaptureRequestBuilder.validateRequestId(record.requestId),
                      let rawURL = URL(string: record.url),
                      let url = try? URLNormalizer.normalizedHTTPURL(rawURL) else {
                    return nil
                }
                return PendingSharedURL(
                    id: record.id,
                    url: url,
                    receivedAt: record.receivedAt,
                    requestId: requestId
                )
            }
            .sorted { left, right in
                if left.receivedAt == right.receivedAt {
                    left.id < right.id
                } else {
                    left.receivedAt < right.receivedAt
                }
            }
    }

    func enqueue(_ url: URL, receivedAt: Date = .now, requestId: String? = nil) throws {
        let id = UUID().uuidString.lowercased()
        let resolvedRequestId: String
        if let requestId {
            resolvedRequestId = try SourceCaptureRequestBuilder.validateRequestId(requestId)
        } else {
            resolvedRequestId = try SourceCaptureRequestBuilder.makeRequestId(now: receivedAt)
        }
        let record = SharedURLRecord(
            id: id,
            url: url.absoluteString,
            receivedAt: receivedAt,
            requestId: resolvedRequestId
        )
        let data = try encoder.encode(record)
        let temporaryURL = queueDirectory.appending(path: "\(id).tmp")
        let finalURL = queueDirectory.appending(path: "\(id).json")
        try data.write(to: temporaryURL, options: .atomic)
        try fileManager.moveItem(at: temporaryURL, to: finalURL)
    }

    func remove(_ item: PendingSharedURL) {
        guard Self.isSafeRecordId(item.id) else {
            return
        }
        let fileURL = queueDirectory.appending(path: "\(item.id).json")
        try? fileManager.removeItem(at: fileURL)
    }

    private static func isSafeRecordId(_ id: String) -> Bool {
        SourceCaptureRequestBuilder.isSafeStorageSegment(id)
    }

    private static func queueDirectory(appGroupId: String?, strict: Bool, fileManager: FileManager) throws -> URL {
        guard let appGroupId,
              !appGroupId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            if strict {
                throw ShareInboxError.missingAppGroupId
            }
            return fileManager.temporaryDirectory.appending(path: "kinic-share-inbox-preview").appending(path: queueDirectoryName)
        }
        guard let containerURL = fileManager.containerURL(forSecurityApplicationGroupIdentifier: appGroupId) else {
            if strict {
                throw ShareInboxError.unavailableAppGroup(appGroupId)
            }
            return fileManager.temporaryDirectory
                .appending(path: "kinic-share-inbox-\(appGroupId)")
                .appending(path: queueDirectoryName)
        }
        return containerURL.appending(path: queueDirectoryName)
    }
}

enum ShareInboxError: LocalizedError, Equatable {
    case missingAppGroupId
    case unavailableAppGroup(String)

    var errorDescription: String? {
        switch self {
        case .missingAppGroupId:
            "APP_GROUP_ID is missing."
        case let .unavailableAppGroup(appGroupId):
            "App Group container is unavailable: \(appGroupId)"
        }
    }
}
