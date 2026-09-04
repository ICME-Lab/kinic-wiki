// Where: mobile/ios/KinicApp/Models/DatabaseCreditProduct.swift
// What: Display model for StoreKit database credit packs.
// Why: Views should not depend on StoreKit product internals.

import Foundation

struct DatabaseCreditProduct: Identifiable, Equatable, Sendable {
    static let smallProductId = "xyz.kinic.dbcredits.small"
    static let smallDisplayAmountCycles: UInt64 = 2_000_000_000_000

    let id: String
    let displayName: String
    let displayPrice: String
    let displayAmountCycles: UInt64

    var displayAmountText: String {
        DatabaseManagementFormat.cycles(displayAmountCycles)
    }

    var purchaseButtonTitle: String {
        "Buy \(displayAmountText) for \(displayPrice)"
    }

    static func configuredDisplayAmountCycles(for productId: String) -> UInt64? {
        switch productId {
        case smallProductId:
            smallDisplayAmountCycles
        default:
            nil
        }
    }
}

struct DatabaseCreditActivation: Equatable, Sendable {
    let databaseId: String
    let purchaserPrincipal: String
    let productId: String
}
