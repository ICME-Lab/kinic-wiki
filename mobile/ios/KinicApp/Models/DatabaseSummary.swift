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

    private static func formatted(_ value: Double) -> String {
        let formatter = NumberFormatter()
        formatter.maximumFractionDigits = value >= 10 ? 0 : 1
        formatter.minimumFractionDigits = 0
        return formatter.string(from: NSNumber(value: value)) ?? String(format: "%.1f", value)
    }
}
