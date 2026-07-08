// Where: mobile/ios/KinicApp/Models/DatabaseSummary.swift
// What: Compact database summary and read-only billing metadata for native browsing.
// Why: Capture, Browse, and DB Info share the same list_databases contract.

import Foundation

struct DatabaseSummary: Codable, Identifiable, Equatable, Sendable {
    let databaseId: String
    let title: String
    let description: String
    let metadata: DatabaseMetadata?
    let role: DatabaseRole
    let status: DatabaseStatus
    let logicalSizeBytes: UInt64
    let cyclesBalance: UInt64?
    let cyclesSuspendedAtMs: Int64?
    let deletedAtMs: Int64?

    var id: String {
        databaseId
    }

    var canWrite: Bool {
        status == .active && role.canWrite
    }

    var canRead: Bool {
        status == .active
    }

    var displayTitle: String {
        title.isEmpty ? databaseId : title
    }
}

struct DatabaseMetadata: Codable, Equatable, Sendable {
    let name: String
    let description: String
    let llmSummary: String?
    let tagsJson: String

    var displayTags: String {
        (try? Self.tags(from: tagsJson).joined(separator: ", ")) ?? tagsJson
    }

    var editTags: String {
        (try? Self.tags(from: tagsJson).joined(separator: ", ")) ?? ""
    }

    static func tags(from tagsJson: String) throws -> [String] {
        try JSONDecoder().decode([String].self, from: Data(tagsJson.utf8))
    }
}

struct CyclesBillingConfig: Equatable, Sendable {
    let kinicLedgerCanisterId: String
    let billingAuthorityId: String
    let cyclesPerKinic: UInt64
    let minUpdateCycles: UInt64
    let topUp: CyclesTopUpConfig
}

struct CyclesTopUpConfig: Equatable, Sendable {
    let enabled: Bool
    let launcherPrincipal: String
    let thresholdCycles: UInt64
}

struct DatabaseMember: Identifiable, Equatable, Sendable {
    let principal: String
    let role: DatabaseRole
    let createdAtMs: Int64

    var id: String {
        principal
    }
}

struct DatabaseCycleEntry: Identifiable, Equatable, Sendable {
    let entryId: UInt64
    let databaseId: String
    let kind: String
    let amountCycles: Int64
    let balanceAfterCycles: UInt64
    let caller: String
    let method: String?
    let ledgerBlockIndex: UInt64?
    let paymentAmountE8s: UInt64?
    let cyclesPerKinic: UInt64?
    let cyclesDelta: UInt64?
    let createdAtMs: Int64

    var id: UInt64 {
        entryId
    }

    var displayTitle: String {
        method?.isEmpty == false ? method ?? kind : kind
    }
}

struct DatabaseCycleEntryPage: Equatable, Sendable {
    let entries: [DatabaseCycleEntry]
    let nextCursor: UInt64?
}

struct DatabaseCyclesPendingPurchase: Identifiable, Equatable, Sendable {
    let operationId: UInt64
    let databaseId: String
    let status: String
    let amountCycles: UInt64
    let paymentAmountE8s: UInt64
    let ledgerBlockIndex: UInt64?
    let createdAtMs: Int64
    let requiredAction: String

    var id: UInt64 {
        operationId
    }
}

struct MarketEntitlement: Equatable, Sendable {
    let databaseId: String
    let buyerPrincipal: String
    let listingId: String
    let orderId: String
    let purchasedAtMs: Int64
    let status: String
}

struct MarketEntitlementPage: Equatable, Sendable {
    let entitlements: [MarketEntitlement]
    let nextCursor: String?
}

enum DatabaseAccessBusyAction: Equatable, Sendable {
    case grant(principal: String, role: DatabaseRole)
    case revoke(principal: String)
    case delete
}

enum DatabaseManagementStatus: Equatable, Sendable {
    case suspended
    case unknown
    case blocked
    case low
    case ok

    static func status(for database: DatabaseSummary, config: CyclesBillingConfig?) -> DatabaseManagementStatus {
        if database.cyclesSuspendedAtMs != nil {
            return .suspended
        }
        guard let balance = database.cyclesBalance else {
            return .unknown
        }
        guard let config else {
            return .unknown
        }
        if balance < config.minUpdateCycles {
            return .blocked
        }
        if config.topUp.enabled && balance < config.topUp.thresholdCycles {
            return .low
        }
        return .ok
    }

    var displayName: String {
        switch self {
        case .suspended:
            "Suspended"
        case .unknown:
            "Unknown"
        case .blocked:
            "Blocked"
        case .low:
            "Low"
        case .ok:
            "OK"
        }
    }
}

enum DatabaseManagementFormat {
    static func cycles(_ value: UInt64?) -> String {
        guard let value else {
            return "Unknown"
        }
        return unsignedCycles(value)
    }

    static func signedCycles(_ value: Int64) -> String {
        if value < 0 {
            return "-\(unsignedCycles(value.magnitude))"
        }
        return unsignedCycles(UInt64(value))
    }

    private static func unsignedCycles(_ value: UInt64) -> String {
        let doubleValue = Double(value)
        if value >= 1_000_000_000_000 {
            return "\(formatted(doubleValue / 1_000_000_000_000))T cycles"
        }
        if value >= 1_000_000_000 {
            return "\(formatted(doubleValue / 1_000_000_000))B cycles"
        }
        if value >= 1_000_000 {
            return "\(formatted(doubleValue / 1_000_000))M cycles"
        }
        return "\(value) cycles"
    }

    static func bytes(_ value: UInt64) -> String {
        let formatter = ByteCountFormatter()
        formatter.allowedUnits = [.useBytes, .useKB, .useMB, .useGB]
        formatter.countStyle = .file
        return formatter.string(fromByteCount: Int64(clamping: value))
    }

    static func date(milliseconds: Int64?) -> String {
        guard let milliseconds else {
            return "Unknown"
        }
        let date = Date(timeIntervalSince1970: TimeInterval(milliseconds) / 1_000)
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter.string(from: date)
    }

    static func date(_ date: Date?) -> String {
        guard let date else {
            return "Unknown"
        }
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter.string(from: date)
    }

    static func date(milliseconds: UInt64) -> String {
        date(milliseconds: Int64(clamping: milliseconds))
    }

    static func tokenE8s(_ value: UInt64) -> String {
        let whole = value / 100_000_000
        let fraction = value % 100_000_000
        if fraction == 0 {
            return "\(whole) KINIC"
        }
        let fractionText = String(format: "%08llu", fraction).trimmingTrailingZeros
        return "\(whole).\(fractionText) KINIC"
    }

    private static func formatted(_ value: Double) -> String {
        let formatter = NumberFormatter()
        formatter.maximumFractionDigits = value >= 10 ? 0 : 1
        formatter.minimumFractionDigits = 0
        return formatter.string(from: NSNumber(value: value)) ?? String(format: "%.1f", value)
    }
}

private extension String {
    var trimmingTrailingZeros: String {
        var text = self
        while text.last == "0" {
            text.removeLast()
        }
        return text
    }
}
