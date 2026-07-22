// Where: mobile/ios/KinicApp/Models/SourceCaptureHistory.swift
// What: Typed source-capture history models shared by the app and extension.
// Why: The device stores the history list and refreshes known request nodes when available.

import Foundation

enum SourceCaptureHistoryStatus: String, Codable, Equatable, Sendable {
    case queued
    case fetching
    case sourceWritten
    case generating
    case completed
    case failed

    var isProcessing: Bool {
        self != .completed && self != .failed
    }
}

extension SourceCaptureHistoryStatus {
    static let fetchingStaleInterval: TimeInterval = 15 * 60
}

struct SourceCaptureHistoryItem: Codable, Identifiable, Equatable, Sendable {
    let requestPath: String
    let url: String
    let status: SourceCaptureHistoryStatus
    let requestedAtMilliseconds: Int64
    let updatedAtMilliseconds: Int64
    let claimedAt: String?
    let sourcePath: String?
    let targetPath: String?
    let finishedAt: String?
    let error: String?
    let lastCheckedAtMilliseconds: Int64?
    let syncError: String?

    init(
        requestPath: String,
        url: String,
        status: SourceCaptureHistoryStatus,
        requestedAtMilliseconds: Int64,
        updatedAtMilliseconds: Int64,
        claimedAt: String?,
        sourcePath: String?,
        targetPath: String?,
        finishedAt: String?,
        error: String?,
        lastCheckedAtMilliseconds: Int64? = nil,
        syncError: String? = nil
    ) {
        self.requestPath = requestPath
        self.url = url
        self.status = status
        self.requestedAtMilliseconds = requestedAtMilliseconds
        self.updatedAtMilliseconds = updatedAtMilliseconds
        self.claimedAt = claimedAt
        self.sourcePath = sourcePath
        self.targetPath = targetPath
        self.finishedAt = finishedAt
        self.error = error
        self.lastCheckedAtMilliseconds = lastCheckedAtMilliseconds
        self.syncError = syncError
    }

    var id: String { requestPath }

    var requestedAt: Date {
        Date(timeIntervalSince1970: TimeInterval(requestedAtMilliseconds) / 1_000)
    }

    func isRetryable(at now: Date = .now) -> Bool {
        switch status {
        case .queued, .sourceWritten, .failed:
            return true
        case .fetching:
            guard let claimedAt,
                  let claimedDate = try? Date(claimedAt, strategy: .iso8601) else {
                return false
            }
            return now.timeIntervalSince(claimedDate) >= SourceCaptureHistoryStatus.fetchingStaleInterval
        case .generating, .completed:
            return false
        }
    }

    func withSyncState(lastCheckedAtMilliseconds: Int64?, syncError: String?) -> SourceCaptureHistoryItem {
        SourceCaptureHistoryItem(
            requestPath: requestPath,
            url: url,
            status: status,
            requestedAtMilliseconds: requestedAtMilliseconds,
            updatedAtMilliseconds: updatedAtMilliseconds,
            claimedAt: claimedAt,
            sourcePath: sourcePath,
            targetPath: targetPath,
            finishedAt: finishedAt,
            error: error,
            lastCheckedAtMilliseconds: lastCheckedAtMilliseconds,
            syncError: syncError
        )
    }
}

struct SourceCaptureHistoryRecord: Codable, Equatable, Identifiable, Sendable {
    let databaseId: String
    var item: SourceCaptureHistoryItem

    init(databaseId: String, item: SourceCaptureHistoryItem) {
        self.databaseId = databaseId
        self.item = item
    }

    init(request: SourceCaptureRequest, requestedAt: Date) {
        let requestedAtMilliseconds = Int64((requestedAt.timeIntervalSince1970 * 1_000).rounded(.down))
        self.databaseId = request.databaseId
        self.item = SourceCaptureHistoryItem(
            requestPath: request.requestPath,
            url: request.normalizedURL.absoluteString,
            status: .queued,
            requestedAtMilliseconds: requestedAtMilliseconds,
            updatedAtMilliseconds: requestedAtMilliseconds,
            claimedAt: nil,
            sourcePath: nil,
            targetPath: nil,
            finishedAt: nil,
            error: nil,
            lastCheckedAtMilliseconds: nil,
            syncError: nil
        )
    }

    var id: String {
        "\(databaseId):\(item.requestPath)"
    }
}
