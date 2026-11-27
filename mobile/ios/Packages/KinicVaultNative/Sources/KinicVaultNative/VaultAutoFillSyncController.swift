import CryptoKit
import Foundation
import KinicVaultCore
import LocalAuthentication

@MainActor public protocol VaultRootKeyStoring {
    func save(_ key: SymmetricKey, context: VaultContext) throws
    func load(context: VaultContext) throws -> SymmetricKey
    func load(context: VaultContext, authenticationContext: LAContext?) throws -> SymmetricKey
    func clear() throws
}

public extension VaultRootKeyStoring {
    func load(context: VaultContext, authenticationContext: LAContext?) throws -> SymmetricKey {
        try load(context: context)
    }
}
@MainActor public protocol VaultIdentityRegistering {
    var isEnabled: Bool { get async }
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

    public func isProviderEnabled() async -> Bool {
        await identities.isEnabled
    }

    public func hasOfflineSnapshot() -> Bool {
        (try? snapshotStore.load()) != nil
    }

    public func offlineSnapshotVaultId() -> Data? {
        (try? snapshotStore.load())?.context.vault
    }

    public func loadOfflineSnapshot(authenticationContext: LAContext? = nil) throws -> (VaultAutoFillSnapshot, SymmetricKey)? {
        guard let snapshot = try snapshotStore.load() else { return nil }
        let key = try keys.load(context: snapshot.context, authenticationContext: authenticationContext)
        return (snapshot, key)
    }

    private func publish(_ candidates: [VaultAutoFillCandidate], ticket: Int) async throws {
        let previous = identityTail
        let update = Task { @MainActor in
            await previous?.value
            guard self.epoch == ticket else { throw CancellationError() }
            if !candidates.isEmpty {
                guard await self.identities.isEnabled else { throw VaultNativeError.providerDisabled }
                guard self.epoch == ticket else { throw CancellationError() }
            }
            try await self.identities.replaceAll(candidates)
        }
        identityTail = Task { _ = try? await update.value }
        try await update.value
        guard epoch == ticket else { throw CancellationError() }
    }

    /// Synchronously fence fetches and remove keys/ciphertext before a logout returns.
    public func invalidate() -> Task<Void, Error> {
        epoch += 1
        let ticket = epoch
        var failed = false
        do { try snapshotStore.clear() } catch { failed = true }
        do { try keys.clear() } catch { failed = true }
        let localCleanupFailed = failed
        return Task { @MainActor in
            var failed = localCleanupFailed
            do { try await self.publish([], ticket: ticket) }
            catch is CancellationError { throw CancellationError() }
            catch { failed = true }
            if failed { throw VaultNativeError.cleanupFailed }
        }
    }

    public func disable() async throws { try await invalidate().value }

    public func registerCachedIdentities(_ payload: VaultAutoFillSyncPayload) async throws {
        let ticket = epoch
        guard try snapshotStore.load() == payload.snapshot else { throw CancellationError() }
        guard await identities.isEnabled else { throw VaultNativeError.providerDisabled }
        guard epoch == ticket, try snapshotStore.load() == payload.snapshot else { throw CancellationError() }
        let candidates = try snapshotStore.listCandidates(rootKey: payload.rootKey)
        try await publish(candidates, ticket: ticket)
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
        guard Self.fitsOfflineCache(payload.snapshot) else {
            try await disable()
            throw VaultNativeError.snapshotTooLarge
        }
        // Validate metadata before any cache or Keychain mutation.
        for record in payload.snapshot.records {
            _ = try VaultDocumentV3.readManifest(rootKey: payload.rootKey, context: context, object: Base64URL.decode(record.objectIdBase64URL), revision: record.revision, manifestBytes: Base64URL.decode(record.manifestBase64URL))
        }
        try keys.save(payload.rootKey, context: context)
        try snapshotStore.save(payload.snapshot)
        let candidates = try snapshotStore.listCandidates(rootKey: payload.rootKey)
        try await publish(candidates, ticket: ticket)
    }

    private static func fitsOfflineCache(_ snapshot: VaultAutoFillSnapshot) -> Bool {
        guard snapshot.records.count <= 1_000 else { return false }
        var remaining = 8 * 1_048_576
        for record in snapshot.records {
            // Snapshot fields use unpadded base64url, so this is the decoded byte count.
            remaining -= record.manifestBase64URL.utf8.count * 3 / 4
            for chunk in record.chunksBase64URL {
                remaining -= chunk.utf8.count * 3 / 4
            }
            if remaining < 0 { return false }
        }
        return true
    }
}
