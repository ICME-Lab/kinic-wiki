// Where: mobile/ios/KinicShareExtension/ShareQueueWriter.swift
// What: App Group writer for browser URLs received from the Share Sheet.
// Why: The extension should finish quickly and leave authenticated work to the app.

import Foundation

struct ShareQueueWriter {
    private static let key = "kinic.pending-shared-urls.v1"
    private let defaults: UserDefaults
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    init(bundle: Bundle = .main) throws {
        let appGroupId = bundle.object(forInfoDictionaryKey: "APP_GROUP_ID").map { "\($0)" } ?? ""
        guard !appGroupId.isEmpty else {
            throw ShareQueueWriterError.missingAppGroupId
        }
        guard let shared = UserDefaults(suiteName: appGroupId) else {
            throw ShareQueueWriterError.unavailableAppGroup(appGroupId)
        }
        defaults = shared
    }

    func enqueue(_ url: URL, receivedAt: Date = .now) throws {
        var records: [ShareQueueRecord]
        if let data = defaults.data(forKey: Self.key),
           let decoded = try? decoder.decode([ShareQueueRecord].self, from: data) {
            records = decoded
        } else {
            records = []
        }
        records.append(ShareQueueRecord(url: url.absoluteString, receivedAt: receivedAt))
        defaults.set(try encoder.encode(records), forKey: Self.key)
    }
}

enum ShareQueueWriterError: LocalizedError {
    case missingAppGroupId
    case unavailableAppGroup(String)

    var errorDescription: String? {
        switch self {
        case .missingAppGroupId:
            "APP_GROUP_ID is missing."
        case .unavailableAppGroup(let appGroupId):
            "App Group is unavailable: \(appGroupId)"
        }
    }
}
