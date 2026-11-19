import CryptoKit
import Foundation
import Testing
import KinicVaultCore
@testable import KinicVaultNative

@MainActor final class TestKeys: VaultRootKeyStoring {
    var key: SymmetricKey?
    func save(_ key: SymmetricKey, context: VaultContext) throws { self.key = key }
    func load(context: VaultContext) throws -> SymmetricKey { guard let key else { throw VaultCryptoError.invalidContext }; return key }
    func clear() throws { key = nil }
}
@MainActor final class TestIdentities: VaultIdentityRegistering {
    var candidates: [VaultAutoFillCandidate] = []
    func replaceAll(_ candidates: [VaultAutoFillCandidate]) async throws { self.candidates = candidates }
}
@MainActor @Test("Disabling AutoFill during a fetch prevents late key or snapshot resurrection")
func disablingFencesPendingSync() async throws {
    let context = try VaultContext(canister: "rrkah-fqaaa-aaaaa-aaaaq-cai", owner: "rrkah-fqaaa-aaaaa-aaaaq-cai", vault: Data(repeating: 1, count: 16), nonce: Data(repeating: 2, count: 32), keyName: "test_key_1")
    let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: url) }
    let store = VaultAutoFillSnapshotStore(fileURL: url)
    let keys = TestKeys(); let identities = TestIdentities()
    let controller = VaultAutoFillSyncController(snapshotStore: store, keys: keys, identities: identities)
    var resume: CheckedContinuation<VaultAutoFillSyncPayload, Never>?
    let task = Task { try await controller.synchronize(context: context) { await withCheckedContinuation { resume = $0 } } }
    while resume == nil { await Task.yield() }
    try await controller.disable()
    resume?.resume(returning: VaultAutoFillSyncPayload(snapshot: VaultAutoFillSnapshot(context: context, records: []), rootKey: SymmetricKey(size: .bits256)))
    do { try await task.value; Issue.record("Disabled sync unexpectedly completed") } catch is CancellationError {} catch { Issue.record("Unexpected error: \(error)") }
    #expect(try store.load() == nil)
    #expect(keys.key == nil)
    #expect(identities.candidates.isEmpty)
}
@MainActor @Test("Only a matching verified context is published")
func verifiesContextBeforePublishing() async throws {
    let context = try VaultContext(canister: "rrkah-fqaaa-aaaaa-aaaaq-cai", owner: "rrkah-fqaaa-aaaaa-aaaaq-cai", vault: Data(repeating: 1, count: 16), nonce: Data(repeating: 2, count: 32), keyName: "test_key_1")
    let other = try VaultContext(canister: context.canister, owner: context.owner, vault: Data(repeating: 3, count: 16), nonce: context.nonce, keyName: context.keyName)
    let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: url) }
    let store = VaultAutoFillSnapshotStore(fileURL: url); let keys = TestKeys(); let identities = TestIdentities()
    let controller = VaultAutoFillSyncController(snapshotStore: store, keys: keys, identities: identities)
    await #expect(throws: VaultCryptoError.invalidContext) {
        try await controller.synchronize(context: context) { VaultAutoFillSyncPayload(snapshot: VaultAutoFillSnapshot(context: other, records: []), rootKey: SymmetricKey(size: .bits256)) }
    }
    #expect(try store.load() == nil)
    #expect(keys.key == nil)
}
