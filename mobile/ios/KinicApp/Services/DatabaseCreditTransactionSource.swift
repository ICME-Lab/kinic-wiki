// Where: mobile/ios/KinicApp/Services/DatabaseCreditTransactionSource.swift
// What: StoreKit unfinished-transaction adapter used by database credit recovery.
// Why: Recovery tests need deterministic verified and unverified transaction sequences.

import Foundation
import StoreKit

protocol DatabaseCreditTransactionSourceProtocol: Sendable {
    func unfinishedTransactions() async -> [DatabaseCreditTransactionEvent]
}

enum DatabaseCreditTransactionEvent: Sendable {
    case verified(DatabaseCreditPendingTransaction)
    case unverified(message: String)
}

struct DatabaseCreditPendingTransaction: Sendable {
    let transactionJWS: String
    let finish: @Sendable () async -> Void
}

struct StoreKitDatabaseCreditTransactionSource: DatabaseCreditTransactionSourceProtocol {
    func unfinishedTransactions() async -> [DatabaseCreditTransactionEvent] {
        var events: [DatabaseCreditTransactionEvent] = []
        for await verification in Transaction.unfinished {
            switch verification {
            case let .verified(transaction):
                events.append(.verified(DatabaseCreditPendingTransaction(
                    transactionJWS: verification.jwsRepresentation,
                    finish: {
                        await transaction.finish()
                    }
                )))
            case let .unverified(_, error):
                events.append(.unverified(
                    message: error.localizedDescription
                ))
            }
        }
        return events
    }
}
