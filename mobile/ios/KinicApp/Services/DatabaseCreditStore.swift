// Where: mobile/ios/KinicApp/Services/DatabaseCreditStore.swift
// What: StoreKit purchase and Payment Worker activation flow.
// Why: AppModel should coordinate state without owning StoreKit or HTTP details.

import Foundation
import StoreKit

protocol DatabaseCreditStoreProtocol: Sendable {
    func loadProducts() async throws -> [DatabaseCreditProduct]
    func purchaseAndActivate(productId: String, databaseId: String, purchaserPrincipal: String) async throws -> DatabaseCreditActivation
    func recoverPendingDatabaseCreditPurchases(purchaserPrincipal: String) async -> DatabaseCreditRecoveryResult
}

actor DatabaseCreditStore: DatabaseCreditStoreProtocol {
    typealias ActivationHandler = @Sendable (_ transactionJWS: String, _ databaseId: String, _ purchaserPrincipal: String) async throws -> DatabaseCreditActivation

    private let configuration: AppConfiguration
    private let urlSession: URLSession
    private let settingsStore: SharedDefaultsStore
    private let transactionSource: any DatabaseCreditTransactionSourceProtocol
    private let activationHandler: ActivationHandler?

    init(
        configuration: AppConfiguration,
        settingsStore: SharedDefaultsStore,
        urlSession: URLSession = .shared,
        transactionSource: any DatabaseCreditTransactionSourceProtocol = StoreKitDatabaseCreditTransactionSource(),
        activationHandler: ActivationHandler? = nil
    ) {
        self.configuration = configuration
        self.settingsStore = settingsStore
        self.urlSession = urlSession
        self.transactionSource = transactionSource
        self.activationHandler = activationHandler
    }

    func loadProducts() async throws -> [DatabaseCreditProduct] {
        let ids = configuration.iapProductIds
        guard !ids.isEmpty else {
            return []
        }
        let products = try await Product.products(for: ids)
        return products
            .sorted { left, right in
                left.displayName.localizedStandardCompare(right.displayName) == .orderedAscending
            }
            .map { product in
                DatabaseCreditProduct(
                    id: product.id,
                    displayName: product.displayName,
                    displayPrice: product.displayPrice
                )
            }
    }

    func purchaseAndActivate(productId: String, databaseId: String, purchaserPrincipal: String) async throws -> DatabaseCreditActivation {
        let product = try await product(for: productId)
        let intent = try await createPurchaseIntent(productId: productId, databaseId: databaseId, purchaserPrincipal: purchaserPrincipal)
        let pending = PendingDatabaseCreditPurchase(
            appAccountToken: intent.appAccountToken.uuidString.lowercased(),
            databaseId: databaseId,
            purchaserPrincipal: purchaserPrincipal,
            productId: productId,
            expiresAtMs: intent.expiresAtMs,
            transactionId: nil,
            transactionJWS: nil
        )
        settingsStore.upsertPendingDatabaseCreditPurchase(pending)
        let result = try await product.purchase(options: [.appAccountToken(intent.appAccountToken)])
        switch result {
        case .success(let verification):
            let transactionJWS = verification.jwsRepresentation
            let transaction: Transaction
            do {
                transaction = try verifiedTransaction(verification)
            } catch {
                settingsStore.upsertPendingDatabaseCreditPurchase(updatedPendingPurchase(pending, transactionId: nil, transactionJWS: transactionJWS))
                throw error
            }
            let saved = updatedPendingPurchase(pending, transactionId: String(transaction.id), transactionJWS: transactionJWS)
            settingsStore.upsertPendingDatabaseCreditPurchase(saved)
            do {
                let activation = try await activate(transactionJWS: transactionJWS, databaseId: databaseId, purchaserPrincipal: purchaserPrincipal)
                await transaction.finish()
                settingsStore.removePendingDatabaseCreditPurchase(appAccountToken: pending.appAccountToken)
                return activation
            } catch {
                throw DatabaseCreditStoreError.activationFailed(error.localizedDescription)
            }
        case .userCancelled:
            settingsStore.removePendingDatabaseCreditPurchase(appAccountToken: pending.appAccountToken)
            throw DatabaseCreditStoreError.userCancelled
        case .pending:
            throw DatabaseCreditStoreError.pending
        @unknown default:
            throw DatabaseCreditStoreError.unknownPurchaseResult
        }
    }

    func recoverPendingDatabaseCreditPurchases(purchaserPrincipal: String) async -> DatabaseCreditRecoveryResult {
        let pending = settingsStore.pendingDatabaseCreditPurchases.filter {
            $0.purchaserPrincipal == purchaserPrincipal
        }
        guard !pending.isEmpty else {
            return DatabaseCreditRecoveryResult(activations: [], failures: [])
        }
        var activations: [DatabaseCreditActivation] = []
        var failures: [DatabaseCreditRecoveryFailure] = []
        for event in await transactionSource.unfinishedTransactions() {
            switch event {
            case let .verified(transaction):
                guard let appAccountToken = transaction.appAccountToken,
                      let saved = pending.first(where: { $0.appAccountToken == appAccountToken }) else {
                    continue
                }
                let updated = updatedPendingPurchase(
                    saved,
                    transactionId: transaction.transactionId,
                    transactionJWS: transaction.transactionJWS
                )
                settingsStore.upsertPendingDatabaseCreditPurchase(updated)
                do {
                    let activation = try await activate(
                        transactionJWS: transaction.transactionJWS,
                        databaseId: saved.databaseId,
                        purchaserPrincipal: saved.purchaserPrincipal
                    )
                    await transaction.finish()
                    settingsStore.removePendingDatabaseCreditPurchase(appAccountToken: appAccountToken)
                    activations.append(activation)
                } catch {
                    failures.append(DatabaseCreditRecoveryFailure(
                        transactionId: transaction.transactionId,
                        message: error.localizedDescription
                    ))
                }
            case let .unverified(transactionId, message):
                failures.append(DatabaseCreditRecoveryFailure(
                    transactionId: transactionId,
                    message: message
                ))
            }
        }
        return DatabaseCreditRecoveryResult(activations: activations, failures: failures)
    }

    private func createPurchaseIntent(productId: String, databaseId: String, purchaserPrincipal: String) async throws -> DatabaseCreditPurchaseIntent {
        var request = URLRequest(url: configuration.iapPurchaseIntentURL)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(DatabaseCreditPurchaseIntentRequest(
            databaseId: databaseId,
            purchaserPrincipal: purchaserPrincipal,
            productId: productId
        ))
        let (data, response) = try await urlSession.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw DatabaseCreditStoreError.invalidActivationResponse
        }
        guard (200..<300).contains(http.statusCode) else {
            let error = (try? JSONDecoder().decode(DatabaseCreditActivationErrorResponse.self, from: data).error) ?? "Database credit purchase intent failed."
            throw DatabaseCreditStoreError.activationRejected(error)
        }
        return try JSONDecoder().decode(DatabaseCreditPurchaseIntent.self, from: data)
    }

    private func product(for productId: String) async throws -> Product {
        let products = try await Product.products(for: [productId])
        guard let product = products.first else {
            throw DatabaseCreditStoreError.productUnavailable
        }
        return product
    }

    private func verifiedTransaction(_ result: VerificationResult<Transaction>) throws -> Transaction {
        switch result {
        case .verified(let transaction):
            transaction
        case .unverified:
            throw DatabaseCreditStoreError.unverifiedTransaction
        }
    }

    private func activate(transactionJWS: String, databaseId: String, purchaserPrincipal: String) async throws -> DatabaseCreditActivation {
        if let activationHandler {
            return try await activationHandler(transactionJWS, databaseId, purchaserPrincipal)
        }
        var request = URLRequest(url: configuration.iapActivateDatabaseURL)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(DatabaseCreditActivationRequest(
            databaseId: databaseId,
            purchaserPrincipal: purchaserPrincipal,
            transactionJWS: transactionJWS
        ))
        let (data, response) = try await urlSession.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw DatabaseCreditStoreError.invalidActivationResponse
        }
        guard (200..<300).contains(http.statusCode) else {
            let error = (try? JSONDecoder().decode(DatabaseCreditActivationErrorResponse.self, from: data).error) ?? "Database credit activation failed."
            throw DatabaseCreditStoreError.activationRejected(error)
        }
        return try JSONDecoder().decode(DatabaseCreditActivationResponse.self, from: data).activation
    }

    private func updatedPendingPurchase(
        _ purchase: PendingDatabaseCreditPurchase,
        transactionId: String?,
        transactionJWS: String?
    ) -> PendingDatabaseCreditPurchase {
        PendingDatabaseCreditPurchase(
            appAccountToken: purchase.appAccountToken,
            databaseId: purchase.databaseId,
            purchaserPrincipal: purchase.purchaserPrincipal,
            productId: purchase.productId,
            expiresAtMs: purchase.expiresAtMs,
            transactionId: transactionId,
            transactionJWS: transactionJWS
        )
    }
}

enum DatabaseCreditStoreError: Error, LocalizedError, Equatable {
    case productUnavailable
    case userCancelled
    case pending
    case unverifiedTransaction
    case unknownPurchaseResult
    case invalidActivationResponse
    case activationRejected(String)
    case activationFailed(String)

    var errorDescription: String? {
        switch self {
        case .productUnavailable:
            "Database credit product is unavailable."
        case .userCancelled:
            "Purchase cancelled."
        case .pending:
            "Purchase is pending App Store approval."
        case .unverifiedTransaction:
            "App Store transaction could not be verified on this device."
        case .unknownPurchaseResult:
            "App Store purchase returned an unsupported result."
        case .invalidActivationResponse:
            "Payment server returned an invalid response."
        case let .activationRejected(message):
            message
        case let .activationFailed(message):
            "Payment server activation failed. Transaction was not finished: \(message)"
        }
    }
}

private struct DatabaseCreditActivationRequest: Encodable {
    let databaseId: String
    let purchaserPrincipal: String
    let transactionJWS: String
}

private struct DatabaseCreditPurchaseIntentRequest: Encodable {
    let databaseId: String
    let purchaserPrincipal: String
    let productId: String
}

private struct DatabaseCreditPurchaseIntent: Decodable {
    let appAccountToken: UUID
    let expiresAtMs: Int64
}

private struct DatabaseCreditActivationResponse: Decodable {
    let fulfilled: Bool
    let transactionId: String
    let databaseId: String
    let productId: String
    let cycles: String
    let balanceCycles: String?

    var activation: DatabaseCreditActivation {
        DatabaseCreditActivation(
            transactionId: transactionId,
            databaseId: databaseId,
            productId: productId,
            cycles: cycles,
            balanceCycles: balanceCycles
        )
    }
}

private struct DatabaseCreditActivationErrorResponse: Decodable {
    let error: String
}
