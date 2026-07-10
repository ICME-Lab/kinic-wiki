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
    case unverified(transactionId: String?, message: String)
}

struct DatabaseCreditPendingTransaction: Sendable {
    let transactionId: String
    let appAccountToken: String?
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
                    transactionId: String(transaction.id),
                    appAccountToken: transaction.appAccountToken?.uuidString.lowercased(),
                    transactionJWS: verification.jwsRepresentation,
                    finish: {
                        await transaction.finish()
                    }
                )))
            case let .unverified(transaction, error):
                events.append(.unverified(
                    transactionId: String(transaction.id),
                    message: error.localizedDescription
                ))
            }
        }
        return events
    }
}
