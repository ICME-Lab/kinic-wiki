// Where: mobile/ios/KinicApp/Services/PendingWorkItemCaptureQueue.swift
// What: File-backed queue for work items captured by the Share Extension.
// Why: App and extension processes append and remove records without a shared SQLite writer.

import Foundation

struct PendingWorkItemCaptureQueue: @unchecked Sendable {
    private static let directoryName = "pending-work-items.v1"
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

    func load() -> [PendingWorkItemCapture] {
        let files = (try? fileManager.contentsOfDirectory(at: queueDirectory, includingPropertiesForKeys: nil)) ?? []
        return files
            .filter { $0.pathExtension == "json" }
            .compactMap { fileURL -> PendingWorkItemCapture? in
                guard let data = try? Data(contentsOf: fileURL),
                      let capture = try? decoder.decode(PendingWorkItemCapture.self, from: data),
                      capture.version == PendingWorkItemCapture.currentVersion,
                      Self.isSafeSegment(capture.captureId),
                      capture.captureId == fileURL.deletingPathExtension().lastPathComponent,
                      !capture.principal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                      !capture.databaseId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                    return nil
                }
                return capture
            }
            .sorted { left, right in
                if left.createdAt == right.createdAt { return left.captureId < right.captureId }
                return left.createdAt < right.createdAt
            }
    }

    func enqueue(_ capture: PendingWorkItemCapture) throws {
        guard Self.isSafeSegment(capture.captureId) else {
            throw PendingWorkItemCaptureQueueError.unsafeCaptureId
        }
        guard capture.version == PendingWorkItemCapture.currentVersion else {
            throw PendingWorkItemCaptureQueueError.unsupportedVersion(capture.version)
        }
        let data = try encoder.encode(capture)
        let temporaryURL = queueDirectory.appending(path: "\(capture.captureId).tmp")
        let finalURL = queueDirectory.appending(path: "\(capture.captureId).json")
        try data.write(to: temporaryURL, options: .atomic)
        // A retry reuses the same capture id, so it must replace its own record instead of failing.
        try? fileManager.removeItem(at: finalURL)
        try fileManager.moveItem(at: temporaryURL, to: finalURL)
    }

    func remove(_ capture: PendingWorkItemCapture) {
        guard Self.isSafeSegment(capture.captureId) else { return }
        try? fileManager.removeItem(at: queueDirectory.appending(path: "\(capture.captureId).json"))
    }

    func removeAll() throws {
        let files = try fileManager.contentsOfDirectory(at: queueDirectory, includingPropertiesForKeys: nil)
        for fileURL in files {
            try fileManager.removeItem(at: fileURL)
        }
    }

    static func isSafeSegment(_ value: String) -> Bool {
        !value.isEmpty && value.allSatisfy { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }
    }

    private static func queueDirectory(appGroupId: String?, strict: Bool, fileManager: FileManager) throws -> URL {
        guard let appGroupId,
              !appGroupId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            if strict {
                throw PendingWorkItemCaptureQueueError.missingAppGroupId
            }
            return fileManager.temporaryDirectory
                .appending(path: "kinic-work-items-preview")
                .appending(path: directoryName)
        }
        guard let containerURL = fileManager.containerURL(forSecurityApplicationGroupIdentifier: appGroupId) else {
            if strict {
                throw PendingWorkItemCaptureQueueError.unavailableAppGroup(appGroupId)
            }
            return fileManager.temporaryDirectory
                .appending(path: "kinic-work-items-\(appGroupId)")
                .appending(path: directoryName)
        }
        return containerURL.appending(path: directoryName)
    }
}

enum PendingWorkItemCaptureQueueError: LocalizedError, Equatable {
    case missingAppGroupId
    case unavailableAppGroup(String)
    case unsafeCaptureId
    case unsupportedVersion(Int)

    var errorDescription: String? {
        switch self {
        case .missingAppGroupId:
            "APP_GROUP_ID is missing."
        case let .unavailableAppGroup(appGroupId):
            "App Group container is unavailable: \(appGroupId)"
        case .unsafeCaptureId:
            "The work item capture identifier is not safe to store."
        case let .unsupportedVersion(version):
            "The work item capture uses unsupported version \(version)."
        }
    }
}
