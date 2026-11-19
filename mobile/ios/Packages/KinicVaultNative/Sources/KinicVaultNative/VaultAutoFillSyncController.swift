import CryptoKit
import Foundation
import KinicVaultCore

@MainActor public protocol VaultRootKeyStoring {
    func save(_ key: SymmetricKey, context: VaultContext) throws
    func load(context: VaultContext) throws -> SymmetricKey
    func clear() throws
}
@MainActor public protocol VaultIdentityRegistering {
    func replaceAll(_ candidates: [VaultAutoFillCandidate]) async throws
}
public struct VaultAutoFillSyncPayload: Sendable {
    public let snapshot: VaultAutoFillSnapshot
    public let rootKey: SymmetricKey
    public init(snapshot: VaultAutoFillSnapshot, rootKey: SymmetricKey) {
        self.snapshot = snapshot; self.rootKey = rootKey
    }
}

/// Host-owned synchronization. A generation fences work across every suspension.
@MainActor public final class VaultAutoFillSyncController {
    private let snapshotStore: VaultAutoFillSnapshotStore
    private let keys: any VaultRootKeyStoring
    private let identities: any VaultIdentityRegistering
    private var epoch = 0
    private var identityTail: Task<Void, Never>?

    public init(snapshotStore: VaultAutoFillSnapshotStore, keys: any VaultRootKeyStoring, identities: any VaultIdentityRegistering) {
        self.snapshotStore = snapshotStore; self.keys = keys; self.identities = identities
    }

    private func publish(_ candidates: [VaultAutoFillCandidate], ticket: Int) async throws {
        let previous = identityTail
        let update = Task { @MainActor in
            await previous?.value
            guard self.epoch == ticket else { throw CancellationError() }
            try await self.identities.replaceAll(candidates)
        }
        identityTail = Task { _ = try? await update.value }
        try await update.value
        guard epoch == ticket else { throw CancellationError() }
    }

    /// Synchronously fence fetches and remove keys/ciphertext before a logout returns.
    public func invalidate() throws -> Task<Void, Error> {
        epoch += 1
        let ticket = epoch
        try snapshotStore.clear()
        try keys.clear()
        return Task { @MainActor in try await self.publish([], ticket: ticket) }
    }

    public func disable() async throws {
        try await invalidate().value
    }

    public func synchronize(context: VaultContext, load: @MainActor () async throws -> VaultAutoFillSyncPayload) async throws {
        epoch += 1
        let ticket = epoch
        if try snapshotStore.load()?.context != context {
            try snapshotStore.clear()
            try keys.clear()
            try await publish([], ticket: ticket)
        }
        let payload = try await load()
        guard epoch == ticket else { throw CancellationError() }
        guard payload.snapshot.context == context else { throw VaultCryptoError.invalidContext }
        // Validate metadata before any cache or Keychain mutation.
        for record in payload.snapshot.records {
            _ = try VaultDocumentV3.readManifest(rootKey: payload.rootKey, context: context, object: Base64URL.decode(record.objectIdBase64URL), revision: record.revision, manifestBytes: Base64URL.decode(record.manifestBase64URL))
        }
        try keys.save(payload.rootKey, context: context)
        try snapshotStore.save(payload.snapshot)
        let candidates = try snapshotStore.listCandidates(rootKey: payload.rootKey)
        try await publish(candidates, ticket: ticket)
    }
}
