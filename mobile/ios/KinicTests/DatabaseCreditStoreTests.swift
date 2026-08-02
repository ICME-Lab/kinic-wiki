// Where: mobile/ios/KinicTests/DatabaseCreditStoreTests.swift
// What: Recovery tests for mixed StoreKit unfinished transaction outcomes.
// Why: One failed or unverified transaction must not block later activations.

import Foundation
import Testing
@testable import Kinic

struct DatabaseCreditStoreTests {
    @Test
    func recoveryContinuesAfterActivationFailure() async throws {
        let harness = try DatabaseCreditRecoveryHarness()
        let firstToken = UUID().uuidString.lowercased()
        let secondToken = UUID().uuidString.lowercased()
        harness.savePending(token: firstToken, databaseId: "db_fail")
        harness.savePending(token: secondToken, databaseId: "db_success")
        let finishRecorder = DatabaseCreditFinishRecorder()
        let source = FakeDatabaseCreditTransactionSource(events: [
            .verified(transaction(id: "tx_fail", token: firstToken, recorder: finishRecorder)),
            .verified(transaction(id: "tx_success", token: secondToken, recorder: finishRecorder))
        ])
        let store = DatabaseCreditStore(
            configuration: .preview,
            settingsStore: harness.settingsStore,
            transactionSource: source,
            activationHandler: { transactionJWS in
                if transactionJWS == "jws_tx_fail" {
                    throw DatabaseCreditRecoveryTestError.activationFailed
                }
                return activation(transactionId: "tx_success", databaseId: "db_success")
            }
        )

        let result = await store.recoverPendingDatabaseCreditPurchases()

        #expect(result.activations == [activation(transactionId: "tx_success", databaseId: "db_success")])
        #expect(result.failures.map(\.transactionId) == ["tx_fail"])
        #expect(result.failures.first?.message == "activation failed")
        #expect(await finishRecorder.finishedTransactionIds() == ["tx_success"])
        #expect(harness.settingsStore.pendingDatabaseCreditPurchases.map(\.appAccountToken) == [firstToken])
        #expect(harness.settingsStore.pendingDatabaseCreditPurchases.first?.transactionId == "tx_fail")
    }

    @Test
    func unverifiedTransactionDoesNotStopLaterRecovery() async throws {
        let harness = try DatabaseCreditRecoveryHarness()
        let token = UUID().uuidString.lowercased()
        harness.savePending(token: token, databaseId: "db_success")
        let finishRecorder = DatabaseCreditFinishRecorder()
        let source = FakeDatabaseCreditTransactionSource(events: [
            .unverified(transactionId: "tx_unverified", message: "device verification failed"),
            .verified(transaction(id: "tx_success", token: token, recorder: finishRecorder))
        ])
        let store = DatabaseCreditStore(
            configuration: .preview,
            settingsStore: harness.settingsStore,
            transactionSource: source,
            activationHandler: { _ in
                activation(transactionId: "tx_success", databaseId: "db_success")
            }
        )

        let result = await store.recoverPendingDatabaseCreditPurchases()

        #expect(result.activations.count == 1)
        #expect(result.failures == [DatabaseCreditRecoveryFailure(
            transactionId: "tx_unverified",
            message: "device verification failed"
        )])
        #expect(await finishRecorder.finishedTransactionIds() == ["tx_success"])
        #expect(harness.settingsStore.pendingDatabaseCreditPurchases.isEmpty)
    }

    @Test
    func recoveryDoesNotRequireLocalPendingPurchase() async throws {
        let harness = try DatabaseCreditRecoveryHarness()
        let token = UUID().uuidString.lowercased()
        let finishRecorder = DatabaseCreditFinishRecorder()
        let source = FakeDatabaseCreditTransactionSource(events: [
            .verified(transaction(id: "tx_reinstalled", token: token, recorder: finishRecorder))
        ])
        let store = DatabaseCreditStore(
            configuration: .preview,
            settingsStore: harness.settingsStore,
            transactionSource: source,
            activationHandler: { _ in
                activation(transactionId: "tx_reinstalled", databaseId: "db_recovered")
            }
        )

        let result = await store.recoverPendingDatabaseCreditPurchases()

        #expect(result.activations == [
            activation(transactionId: "tx_reinstalled", databaseId: "db_recovered")
        ])
        #expect(result.failures.isEmpty)
        #expect(await finishRecorder.finishedTransactionIds() == ["tx_reinstalled"])
    }

    @MainActor
    @Test
    func appModelRecoveryErrorShowsFirstFailureAndRemainingCount() {
        let failures = [
            DatabaseCreditRecoveryFailure(transactionId: "tx_1", message: "first failure"),
            DatabaseCreditRecoveryFailure(transactionId: "tx_2", message: "second failure"),
            DatabaseCreditRecoveryFailure(transactionId: "tx_3", message: "third failure")
        ]

        #expect(AppModel.databaseCreditRecoveryError(failures) == "first failure (2 more transactions failed.)")
        #expect(AppModel.databaseCreditRecoveryError([]) == nil)
    }

    @MainActor
    @Test
    func appModelAppliesOnlyCurrentPrincipalRecoveries() {
        let current = activation(transactionId: "tx_current", databaseId: "db_current")
        let other = DatabaseCreditActivation(
            transactionId: "tx_other",
            databaseId: "db_other",
            purchaserPrincipal: "rrkah-fqaaa-aaaaa-aaaaq-cai",
            productId: "xyz.kinic.dbcredits.small",
            cycles: "12345",
            balanceCycles: "67890"
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

private struct DatabaseCreditRecoveryHarness {
    let principal = "r7inp-6aaaa-aaaaa-aaabq-cai"
    let suiteName: String
    let settingsStore: SharedDefaultsStore

    init() throws {
        suiteName = "kinic.database-credit-recovery-tests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defaults.removePersistentDomain(forName: suiteName)
        settingsStore = SharedDefaultsStore(defaults: defaults)
    }

    func savePending(token: String, databaseId: String) {
        settingsStore.upsertPendingDatabaseCreditPurchase(PendingDatabaseCreditPurchase(
            appAccountToken: token,
            databaseId: databaseId,
            purchaserPrincipal: principal,
            productId: "xyz.kinic.dbcredits.small",
            expiresAtMs: 1,
            transactionId: nil,
            transactionJWS: nil
        ))
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
    token: String,
    recorder: DatabaseCreditFinishRecorder
) -> DatabaseCreditPendingTransaction {
    DatabaseCreditPendingTransaction(
        transactionId: id,
        appAccountToken: token,
        transactionJWS: "jws_\(id)",
        finish: {
            await recorder.record(id)
        }
    )
}

private func activation(transactionId: String, databaseId: String) -> DatabaseCreditActivation {
    DatabaseCreditActivation(
        transactionId: transactionId,
        databaseId: databaseId,
        purchaserPrincipal: "r7inp-6aaaa-aaaaa-aaabq-cai",
        productId: "xyz.kinic.dbcredits.small",
        cycles: "12345",
        balanceCycles: "67890"
    )
}
