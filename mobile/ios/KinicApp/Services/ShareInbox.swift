// Where: mobile/ios/KinicApp/Services/ShareInbox.swift
// What: Reader and writer for URLs queued by the Share Extension or manual entry.
// Why: The app owns authenticated canister writes, regardless of capture source.

import Foundation

struct ShareInbox: @unchecked Sendable {
    private static let key = "kinic.pending-shared-urls.v1"
    private let defaults: UserDefaults
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    init(appGroupId: String?) {
        defaults = SharedDefaultsStore.defaults(appGroupId: appGroupId)
    }

    init(strictAppGroupId appGroupId: String?) throws {
        guard let appGroupId,
              !appGroupId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw ShareInboxError.missingAppGroupId
        }
        guard let defaults = UserDefaults(suiteName: appGroupId) else {
            throw ShareInboxError.unavailableAppGroup(appGroupId)
        }
        self.defaults = defaults
    }

    func loadPendingURLs() -> [PendingSharedURL] {
        let records: [SharedURLRecord]
        if let data = defaults.data(forKey: Self.key),
           let decoded = try? decoder.decode([SharedURLRecord].self, from: data) {
            records = decoded
        } else {
            records = []
        }
        return records.compactMap { record in
            guard let url = URL(string: record.url) else {
                return nil
            }
            return PendingSharedURL(url: url, receivedAt: record.receivedAt)
        }
    }

    func enqueue(_ url: URL, receivedAt: Date = .now) throws {
        var records = loadPendingURLs().map { SharedURLRecord(url: $0.url.absoluteString, receivedAt: $0.receivedAt) }
        records.append(SharedURLRecord(url: url.absoluteString, receivedAt: receivedAt))
        defaults.set(try encoder.encode(records), forKey: Self.key)
    }

    func remove(_ item: PendingSharedURL) {
        let remaining = loadPendingURLs().filter { $0 != item }
        let records = remaining.map { SharedURLRecord(url: $0.url.absoluteString, receivedAt: $0.receivedAt) }
        defaults.set(try? encoder.encode(records), forKey: Self.key)
    }
}

enum ShareInboxError: LocalizedError {
    case missingAppGroupId
    case unavailableAppGroup(String)

    var errorDescription: String? {
        switch self {
        case .missingAppGroupId:
            "APP_GROUP_ID is missing."
        case let .unavailableAppGroup(appGroupId):
            "App Group is unavailable: \(appGroupId)"
        }
    }
}
