// Where: mobile/ios/KinicApp/Models/DatabaseCreditRecoveryResult.swift
// What: Aggregate outcome for unfinished StoreKit transaction recovery.
// Why: One failed transaction must not discard successful activations from the same scan.

import Foundation

struct DatabaseCreditRecoveryResult: Equatable, Sendable {
    let activations: [DatabaseCreditActivation]
    let failures: [DatabaseCreditRecoveryFailure]
}

struct DatabaseCreditRecoveryFailure: Equatable, Sendable {
    let message: String
}
