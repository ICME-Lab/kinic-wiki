// Where: mobile/ios/KinicApp/Services/ShareInbox.swift
// What: Reader for URLs queued by the Share Extension.
// Why: The extension cannot own long-running auth or canister writes.

import Foundation

struct ShareInbox {
    private static let key = "kinic.pending-shared-urls.v1"
    private let defaults: UserDefaults
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    init(appGroupId: String?) {
        defaults = SharedDefaultsStore.defaults(appGroupId: appGroupId)
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

    func remove(_ item: PendingSharedURL) {
        let remaining = loadPendingURLs().filter { $0 != item }
        let records = remaining.map { SharedURLRecord(url: $0.url.absoluteString, receivedAt: $0.receivedAt) }
        defaults.set(try? encoder.encode(records), forKey: Self.key)
    }
}
