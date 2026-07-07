// Where: mobile/ios/KinicApp/Services/SharedDefaultsStore.swift
// What: Small wrapper around UserDefaults and App Group storage.
// Why: App settings and extension inbox must share the same suite when configured.

import Foundation

struct SharedDefaultsStore: @unchecked Sendable {
    private static let databaseIdKey = "kinic.database-id.v1"
    private let defaults: UserDefaults

    init(appGroupId: String?, strict: Bool = false) throws {
        defaults = try Self.defaults(appGroupId: appGroupId, strict: strict)
    }

    init(defaults: UserDefaults) {
        self.defaults = defaults
    }

    var databaseId: String {
        get {
            defaults.string(forKey: Self.databaseIdKey) ?? ""
        }
        nonmutating set {
            defaults.set(newValue, forKey: Self.databaseIdKey)
        }
    }

    static func defaults(appGroupId: String?, strict: Bool = false) throws -> UserDefaults {
        guard let appGroupId,
              !appGroupId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            if strict {
                throw SharedDefaultsStoreError.missingAppGroupId
            }
            return .standard
        }
        guard let shared = UserDefaults(suiteName: appGroupId) else {
            if strict {
                throw SharedDefaultsStoreError.unavailableAppGroup(appGroupId)
            }
            return .standard
        }
        return shared
    }
}

enum SharedDefaultsStoreError: LocalizedError, Equatable {
    case missingAppGroupId
    case unavailableAppGroup(String)

    var errorDescription: String? {
        switch self {
        case .missingAppGroupId:
            "APP_GROUP_ID is missing."
        case let .unavailableAppGroup(appGroupId):
            "App Group defaults are unavailable: \(appGroupId)"
        }
    }
}
