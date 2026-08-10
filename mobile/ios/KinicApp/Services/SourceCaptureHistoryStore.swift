// Where: mobile/ios/KinicApp/Services/SourceCaptureHistoryStore.swift
// What: App Group persistence for locally submitted source-capture requests.
// Why: The device owns the history list; Canister reads only refresh known request paths.

import Foundation

struct SourceCaptureHistoryStore: @unchecked Sendable {
    static let maxRecordsPerDatabase = 100

    private static let directoryName = "source-capture-history.v1"
    private let historyDirectory: URL
    private let fileManager: FileManager
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    init(appGroupId: String?, strict: Bool = false, fileManager: FileManager = .default) throws {
        self.fileManager = fileManager
        historyDirectory = try Self.historyDirectory(appGroupId: appGroupId, strict: strict, fileManager: fileManager)
        try fileManager.createDirectory(at: historyDirectory, withIntermediateDirectories: true)
    }

    init(testHistoryDirectory: URL, fileManager: FileManager = .default) throws {
        self.fileManager = fileManager
        historyDirectory = testHistoryDirectory
        try fileManager.createDirectory(at: historyDirectory, withIntermediateDirectories: true)
    }

    func load(databaseId: String) -> [SourceCaptureHistoryRecord] {
        guard let directory = databaseDirectory(databaseId: databaseId),
              let files = try? fileManager.contentsOfDirectory(
                  at: directory,
                  includingPropertiesForKeys: nil
              ) else {
            return []
        }
        return files
            .filter { $0.pathExtension == "json" }
            .compactMap { fileURL in
                guard let data = try? Data(contentsOf: fileURL),
                      let record = try? decoder.decode(SourceCaptureHistoryRecord.self, from: data),
                      record.databaseId == databaseId,
                      Self.requestId(from: record.item.requestPath) != nil else {
                    return nil
                }
                return record
            }
            .sorted { left, right in
                if left.item.requestedAtMilliseconds == right.item.requestedAtMilliseconds {
                    left.item.requestPath > right.item.requestPath
                } else {
                    left.item.requestedAtMilliseconds > right.item.requestedAtMilliseconds
                }
            }
            .prefix(Self.maxRecordsPerDatabase)
            .map { $0 }
    }

    func save(_ record: SourceCaptureHistoryRecord) throws {
        guard let directory = databaseDirectory(databaseId: record.databaseId),
              let requestId = Self.requestId(from: record.item.requestPath) else {
            throw SourceCaptureHistoryStoreError.invalidRecord
        }
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        let data = try encoder.encode(record)
        try data.write(to: directory.appending(path: "\(requestId).json"), options: [.atomic])
        prune(databaseId: record.databaseId, directory: directory)
    }

    func removeAll() throws {
        let entries = try fileManager.contentsOfDirectory(
            at: historyDirectory,
            includingPropertiesForKeys: nil
        )
        for entryURL in entries {
            try fileManager.removeItem(at: entryURL)
        }
    }

    private func prune(databaseId: String, directory: URL) {
        let records = loadAll(databaseId: databaseId, directory: directory)
        for record in records.dropFirst(Self.maxRecordsPerDatabase) {
            guard let requestId = Self.requestId(from: record.item.requestPath) else { continue }
            try? fileManager.removeItem(at: directory.appending(path: "\(requestId).json"))
        }
    }

    private func loadAll(databaseId: String, directory: URL) -> [SourceCaptureHistoryRecord] {
        let files = (try? fileManager.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: nil
        )) ?? []
        return files
            .filter { $0.pathExtension == "json" }
            .compactMap { fileURL in
                guard let data = try? Data(contentsOf: fileURL),
                      let record = try? decoder.decode(SourceCaptureHistoryRecord.self, from: data),
                      record.databaseId == databaseId,
                      Self.requestId(from: record.item.requestPath) != nil else {
                    return nil
                }
                return record
            }
            .sorted { left, right in
                if left.item.requestedAtMilliseconds == right.item.requestedAtMilliseconds {
                    left.item.requestPath > right.item.requestPath
                } else {
                    left.item.requestedAtMilliseconds > right.item.requestedAtMilliseconds
                }
            }
    }

    private func databaseDirectory(databaseId: String) -> URL? {
        guard SourceCaptureRequestBuilder.isSafeStorageSegment(databaseId) else {
            return nil
        }
        return historyDirectory.appending(path: databaseId)
    }

    private static func requestId(from requestPath: String) -> String? {
        SourceCaptureContract.requestId(from: requestPath)
    }

    private static func isSafeStorageSegment(_ value: String) -> Bool {
        SourceCaptureContract.isSafeRequestId(value)
    }

    private static func historyDirectory(appGroupId: String?, strict: Bool, fileManager: FileManager) throws -> URL {
        guard let appGroupId,
              !appGroupId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            if strict {
                throw SourceCaptureHistoryStoreError.missingAppGroupId
            }
            return fileManager.temporaryDirectory.appending(path: directoryName)
        }
        guard let containerURL = fileManager.containerURL(forSecurityApplicationGroupIdentifier: appGroupId) else {
            if strict {
                throw SourceCaptureHistoryStoreError.unavailableAppGroup(appGroupId)
            }
            return fileManager.temporaryDirectory
                .appending(path: "kinic-source-capture-history-\(appGroupId)")
                .appending(path: directoryName)
        }
        return containerURL.appending(path: directoryName)
    }
}

enum SourceCaptureHistoryStoreError: LocalizedError, Equatable {
    case invalidRecord
    case missingAppGroupId
    case unavailableAppGroup(String)

    var errorDescription: String? {
        switch self {
        case .invalidRecord:
            "Source capture history record is invalid."
        case .missingAppGroupId:
            "APP_GROUP_ID is missing."
        case let .unavailableAppGroup(appGroupId):
            "App Group container is unavailable: \(appGroupId)"
        }
    }
}
