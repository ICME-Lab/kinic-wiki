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

    var shareSelectionDetailText: String {
        "\(role.displayName) · \(shareSelectionDatabaseIdText)"
    }

    var shareSelectionTitleText: String {
        let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmedTitle.isEmpty ? "Untitled database" : trimmedTitle
    }

    var roleAndCyclesBalanceText: String {
        guard let cyclesBalance else {
            return role.displayName
        }
        return "\(role.displayName) · \(DatabaseManagementFormat.cycles(cyclesBalance))"
    }

    private var shareSelectionDatabaseIdText: String {
        guard databaseId.count > 18 else {
            return databaseId
        }
        return "\(databaseId.prefix(8))…\(databaseId.suffix(6))"
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
    let iapAuthorityId: String?
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
    var voiceSessionId: String? = nil
    var voiceSeconds: UInt64? = nil
    var voiceRateVersion: UInt64? = nil
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
        switch kind {
        case "voice_reserve": "Voice credit reservation"
        case "voice_release": "Unused voice credits returned"
        case "voice_settle": "Voice usage confirmed"
        case "voice_expired_release": "Unconfirmed voice credits returned"
        default: method?.isEmpty == false ? method ?? kind : kind
        }
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
        formatter.maximumFractionDigits = value >= 10 ? 0 : 3
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

// Exact decimal editing; display rounding must never change a stored budget.
enum CycleBudgetUnit: Int, CaseIterable, Identifiable {
    case cycles = 0, million = 6, billion = 9, trillion = 12
    var id: Int { rawValue }
    var title: String {
        switch self {
        case .cycles: "cycles"
        case .million: "M cycles"
        case .billion: "B cycles"
        case .trillion: "T cycles"
        }
    }
    static func preferred(for value: UInt64) -> Self {
        if value >= 1_000_000_000_000 { return .trillion }
        if value >= 1_000_000_000 { return .billion }
        if value >= 1_000_000 { return .million }
        return .cycles
    }
    func text(for value: UInt64) -> String {
        guard rawValue > 0 else { return String(value) }
        let digits = String(repeating: "0", count: rawValue) + String(value)
        let split = digits.index(digits.endIndex, offsetBy: -rawValue)
        let whole = String(digits[..<split]).drop(while: { $0 == "0" })
        var fraction = String(digits[split...])
        while fraction.last == "0" { fraction.removeLast() }
        return (whole.isEmpty ? "0" : String(whole)) + (fraction.isEmpty ? "" : "." + fraction)
    }
    func cycles(from input: String) -> UInt64? {
        let separator = Locale.current.decimalSeparator ?? "."
        let normalized = input.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: separator, with: ".")
        let parts = normalized.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count <= 2, !normalized.isEmpty,
              parts.allSatisfy({ $0.utf8.allSatisfy { $0 >= 48 && $0 <= 57 } }),
              parts.contains(where: { !$0.isEmpty }) else { return nil }
        var fraction = parts.count == 2 ? String(parts[1]) : ""
        while fraction.last == "0" { fraction.removeLast() }
        guard fraction.count <= rawValue else { return nil }
        let digits = String(parts[0]) + fraction + String(repeating: "0", count: rawValue - fraction.count)
        guard let value = UInt64(digits), value <= UInt64(Int64.max) else { return nil }
        return value
    }
}
