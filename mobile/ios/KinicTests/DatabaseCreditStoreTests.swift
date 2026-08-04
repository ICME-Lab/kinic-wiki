// Where: mobile/ios/KinicTests/DatabaseCreditStoreTests.swift
// What: Recovery tests for mixed StoreKit unfinished transaction outcomes.
// Why: One failed or unverified transaction must not block later activations.

import Foundation
import Testing
@testable import Kinic

struct DatabaseCreditStoreTests {
    @Test
    func recoveryContinuesAfterActivationFailure() async throws {
        let finishRecorder = DatabaseCreditFinishRecorder()
        let source = FakeDatabaseCreditTransactionSource(events: [
            .verified(transaction(id: "tx_fail", recorder: finishRecorder)),
            .verified(transaction(id: "tx_success", recorder: finishRecorder))
        ])
        let store = DatabaseCreditStore(
            configuration: .preview,
            transactionSource: source,
            activationHandler: { transactionJWS in
                if transactionJWS == "jws_tx_fail" {
                    throw DatabaseCreditRecoveryTestError.activationFailed
                }
                return activation(databaseId: "db_success")
            }
        )

        let result = await store.recoverPendingDatabaseCreditPurchases()

        #expect(result.activations == [activation(databaseId: "db_success")])
        #expect(result.failures.count == 1)
        #expect(result.failures.first?.message == "activation failed")
        #expect(await finishRecorder.finishedTransactionIds() == ["tx_success"])
    }

    @Test
    func unverifiedTransactionDoesNotStopLaterRecovery() async throws {
        let finishRecorder = DatabaseCreditFinishRecorder()
        let source = FakeDatabaseCreditTransactionSource(events: [
            .unverified(message: "device verification failed"),
            .verified(transaction(id: "tx_success", recorder: finishRecorder))
        ])
        let store = DatabaseCreditStore(
            configuration: .preview,
            transactionSource: source,
            activationHandler: { _ in
                activation(databaseId: "db_success")
            }
        )

        let result = await store.recoverPendingDatabaseCreditPurchases()

        #expect(result.activations.count == 1)
        #expect(result.failures == [DatabaseCreditRecoveryFailure(
            message: "device verification failed"
        )])
        #expect(await finishRecorder.finishedTransactionIds() == ["tx_success"])
    }

    @Test
    func recoveryDoesNotRequireLocalPendingPurchase() async throws {
        let finishRecorder = DatabaseCreditFinishRecorder()
        let source = FakeDatabaseCreditTransactionSource(events: [
            .verified(transaction(id: "tx_reinstalled", recorder: finishRecorder))
        ])
        let store = DatabaseCreditStore(
            configuration: .preview,
            transactionSource: source,
            activationHandler: { _ in
                activation(databaseId: "db_recovered")
            }
        )

        let result = await store.recoverPendingDatabaseCreditPurchases()

        #expect(result.activations == [
            activation(databaseId: "db_recovered")
        ])
        #expect(result.failures.isEmpty)
        #expect(await finishRecorder.finishedTransactionIds() == ["tx_reinstalled"])
    }

    @MainActor
    @Test
    func appModelRecoveryErrorShowsFirstFailureAndRemainingCount() {
        let failures = [
            DatabaseCreditRecoveryFailure(message: "first failure"),
            DatabaseCreditRecoveryFailure(message: "second failure"),
            DatabaseCreditRecoveryFailure(message: "third failure")
        ]

        #expect(AppModel.databaseCreditRecoveryError(failures) == "first failure (2 more transactions failed.)")
        #expect(AppModel.databaseCreditRecoveryError([]) == nil)
    }

    @MainActor
    @Test
    func appModelAppliesOnlyCurrentPrincipalRecoveries() {
        let current = activation(databaseId: "db_current")
        let other = DatabaseCreditActivation(
            databaseId: "db_other",
            purchaserPrincipal: "rrkah-fqaaa-aaaaa-aaaaq-cai",
            productId: "xyz.kinic.dbcredits.small"
        )

        #expect(AppModel.databaseCreditActivations(
            [current, other],
            for: current.purchaserPrincipal
        ) == [current])
        #expect(AppModel.databaseCreditActivations([current], for: nil).isEmpty)
    }
}

private struct FakeDatabaseCreditTransactionSource: DatabaseCreditTransactionSourceProtocol {
    let events: [DatabaseCreditTransactionEvent]

    func unfinishedTransactions() async -> [DatabaseCreditTransactionEvent] {
        events
    }
}

private actor DatabaseCreditFinishRecorder {
    private var transactionIds: [String] = []

    func record(_ transactionId: String) {
        transactionIds.append(transactionId)
    }

    func finishedTransactionIds() -> [String] {
        transactionIds
    }
}

private enum DatabaseCreditRecoveryTestError: LocalizedError {
    case activationFailed

    var errorDescription: String? {
        "activation failed"
    }
}

private func transaction(
    id: String,
    recorder: DatabaseCreditFinishRecorder
) -> DatabaseCreditPendingTransaction {
    DatabaseCreditPendingTransaction(
        transactionJWS: "jws_\(id)",
        finish: {
            await recorder.record(id)
        }
    )
}

private func activation(databaseId: String) -> DatabaseCreditActivation {
    DatabaseCreditActivation(
        databaseId: databaseId,
        purchaserPrincipal: "r7inp-6aaaa-aaaaa-aaabq-cai",
        productId: "xyz.kinic.dbcredits.small"
    )
}
