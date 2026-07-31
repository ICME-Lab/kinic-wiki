// Where: mobile/ios/KinicApp/Services/SharedDefaultsStore.swift
// What: Small wrapper around UserDefaults and App Group storage.
// Why: App settings and extension inbox must share the same suite when configured.

import Foundation

struct PendingDatabaseCreditPurchase: Codable, Equatable, Sendable {
    let appAccountToken: String
    let databaseId: String
    let purchaserPrincipal: String
    let productId: String
    let expiresAtMs: Int64
    let transactionId: String?
    let transactionJWS: String?
}

struct SharedDefaultsStore: @unchecked Sendable {
    private static let databaseIdKey = "kinic.database-id.v1"
    private static let isDarkAppearanceEnabledKey = "kinic.appearance-is-dark.v1"
    private static let browseDatabaseVisibilityDefaultsVersionKey = "kinic.browse-database-visibility-defaults-version"
    private static let currentBrowseDatabaseVisibilityDefaultsVersion = 2
    private static let showPublicBrowseDatabasesKey = "kinic.browse-show-public-databases.v1"
    private static let showPurchasedBrowseDatabasesKey = "kinic.browse-show-purchased-databases.v1"
    private static let wikiOutputLanguageKey = "kinic.wiki-output-language.v1"
    private static let writableDatabasesKey = "kinic.writable-databases.v1"
    private static let pendingDatabaseCreditPurchasesKey = "kinic.pending-database-credit-purchases.v1"
    private let defaults: UserDefaults
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    init(appGroupId: String?, strict: Bool = false) throws {
        defaults = try Self.defaults(appGroupId: appGroupId, strict: strict)
        migrateBrowseDatabaseVisibilityDefaults()
    }

    init(defaults: UserDefaults) {
        self.defaults = defaults
        migrateBrowseDatabaseVisibilityDefaults()
    }

    var databaseId: String {
        get {
            defaults.string(forKey: Self.databaseIdKey) ?? ""
        }
        nonmutating set {
            defaults.set(newValue, forKey: Self.databaseIdKey)
        }
    }

    var isDarkAppearanceEnabled: Bool {
        get {
            defaults.bool(forKey: Self.isDarkAppearanceEnabledKey)
        }
        nonmutating set {
            defaults.set(newValue, forKey: Self.isDarkAppearanceEnabledKey)
        }
    }

    var showPublicBrowseDatabases: Bool {
        get {
            defaults.object(forKey: Self.showPublicBrowseDatabasesKey) == nil
                ? true
                : defaults.bool(forKey: Self.showPublicBrowseDatabasesKey)
        }
        nonmutating set {
            defaults.set(newValue, forKey: Self.showPublicBrowseDatabasesKey)
        }
    }

    var showPurchasedBrowseDatabases: Bool {
        get {
            defaults.bool(forKey: Self.showPurchasedBrowseDatabasesKey)
        }
        nonmutating set {
            defaults.set(newValue, forKey: Self.showPurchasedBrowseDatabasesKey)
        }
    }

    var wikiOutputLanguage: WikiOutputLanguage {
        get {
            guard let value = defaults.string(forKey: Self.wikiOutputLanguageKey),
                  let language = WikiOutputLanguage(rawValue: value) else {
                return .english
            }
            return language
        }
        nonmutating set {
            defaults.set(newValue.rawValue, forKey: Self.wikiOutputLanguageKey)
        }
    }

    var writableDatabases: [DatabaseSummary] {
        get {
            guard let data = defaults.data(forKey: Self.writableDatabasesKey),
                  let databases = try? decoder.decode([DatabaseSummary].self, from: data) else {
                return []
            }
            return databases.filter(\.canWrite)
        }
        nonmutating set {
            let writable = newValue.filter(\.canWrite)
            guard let data = try? encoder.encode(writable) else {
                defaults.removeObject(forKey: Self.writableDatabasesKey)
                return
            }
            defaults.set(data, forKey: Self.writableDatabasesKey)
        }
    }

    var pendingDatabaseCreditPurchases: [PendingDatabaseCreditPurchase] {
        get {
            guard let data = defaults.data(forKey: Self.pendingDatabaseCreditPurchasesKey),
                  let purchases = try? decoder.decode([PendingDatabaseCreditPurchase].self, from: data) else {
                return []
            }
            return purchases
        }
        nonmutating set {
            guard let data = try? encoder.encode(newValue) else {
                defaults.removeObject(forKey: Self.pendingDatabaseCreditPurchasesKey)
                return
            }
            defaults.set(data, forKey: Self.pendingDatabaseCreditPurchasesKey)
        }
    }

    func upsertPendingDatabaseCreditPurchase(_ purchase: PendingDatabaseCreditPurchase) {
        var purchases = pendingDatabaseCreditPurchases
        purchases.removeAll { $0.appAccountToken == purchase.appAccountToken }
        purchases.append(purchase)
        pendingDatabaseCreditPurchases = purchases
    }

    func removePendingDatabaseCreditPurchase(appAccountToken: String) {
        pendingDatabaseCreditPurchases = pendingDatabaseCreditPurchases.filter {
            $0.appAccountToken != appAccountToken
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

    private func migrateBrowseDatabaseVisibilityDefaults() {
        guard defaults.integer(forKey: Self.browseDatabaseVisibilityDefaultsVersionKey)
                < Self.currentBrowseDatabaseVisibilityDefaultsVersion else {
            return
        }
        defaults.set(true, forKey: Self.showPublicBrowseDatabasesKey)
        defaults.set(
            Self.currentBrowseDatabaseVisibilityDefaultsVersion,
            forKey: Self.browseDatabaseVisibilityDefaultsVersionKey
        )
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
