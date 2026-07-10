// Where: mobile/ios/KinicApp/Models/DatabaseCreditProduct.swift
// What: Display model for StoreKit database credit packs.
// Why: Views should not depend on StoreKit product internals.

import Foundation

struct DatabaseCreditProduct: Identifiable, Equatable, Sendable {
    let id: String
    let displayName: String
    let displayPrice: String
}

struct DatabaseCreditActivation: Equatable, Sendable {
    let transactionId: String
    let databaseId: String
    let productId: String
    let cycles: String
    let balanceCycles: String?
}
