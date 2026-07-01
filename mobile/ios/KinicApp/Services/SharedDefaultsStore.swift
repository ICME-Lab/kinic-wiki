// Where: mobile/ios/KinicApp/Services/SharedDefaultsStore.swift
// What: Small wrapper around UserDefaults and App Group storage.
// Why: App settings and extension inbox must share the same suite when configured.

import Foundation

struct SharedDefaultsStore: @unchecked Sendable {
    private static let databaseIdKey = "kinic.database-id.v1"
    private let defaults: UserDefaults

    init(appGroupId: String?) {
        defaults = Self.defaults(appGroupId: appGroupId)
    }

    var databaseId: String {
        get {
            defaults.string(forKey: Self.databaseIdKey) ?? ""
        }
        nonmutating set {
            defaults.set(newValue, forKey: Self.databaseIdKey)
        }
    }

    static func defaults(appGroupId: String?) -> UserDefaults {
        guard let appGroupId,
              !appGroupId.isEmpty,
              let shared = UserDefaults(suiteName: appGroupId) else {
            return .standard
        }
        return shared
    }
}
