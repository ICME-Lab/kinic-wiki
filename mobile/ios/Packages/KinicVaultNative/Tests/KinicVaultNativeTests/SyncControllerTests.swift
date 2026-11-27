import CryptoKit
import Foundation
import Testing
import KinicVaultCore
@testable import KinicVaultNative

@MainActor final class TestKeys: VaultRootKeyStoring {
    var key: SymmetricKey?
    private(set) var saveCount = 0
    func save(_ key: SymmetricKey, context: VaultContext) throws {
        self.key = key
        saveCount += 1
    }
    func load(context: VaultContext) throws -> SymmetricKey { guard let key else { throw VaultCryptoError.invalidContext }; return key }
    func clear() throws { key = nil }
}
@MainActor final class TestIdentities: VaultIdentityRegistering {
    var isEnabled = true
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

@MainActor private func cachedPayload() throws -> VaultAutoFillSyncPayload {
    let context = try VaultContext(canister: "rrkah-fqaaa-aaaaa-aaaaq-cai", owner: "rrkah-fqaaa-aaaaa-aaaaq-cai", vault: Data(repeating: 1, count: 16), nonce: Data(repeating: 2, count: 32), keyName: "test_key_1")
    let key = SymmetricKey(size: .bits256)
    let object = Data(repeating: 4, count: 16)
    let document = try VaultDocumentV3.encrypt(rootKey: key, context: context, object: object, revision: 1, metadata: VaultMetadata(kind: .credential, title: "Test", username: "alice", domains: ["example.com"]), plaintext: Data("{\"username\":\"alice\",\"password\":\"example-password\"}".utf8))
    let record = VaultAutoFillRecordSnapshot(objectIdBase64URL: Base64URL.encode(object), revision: 1, manifestBase64URL: Base64URL.encode(document.manifest), chunksBase64URL: document.chunks.map(Base64URL.encode), hashesBase64URL: document.hashes.map(Base64URL.encode))
    return VaultAutoFillSyncPayload(snapshot: VaultAutoFillSnapshot(context: context, records: [record]), rootKey: key)
}

@MainActor @Test("Snapshot deletion failure still clears keys and OS identities and reports failure")
func cleanupAttemptsEveryChannel() async throws {
    let payload = try cachedPayload()
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: dir.path); try? FileManager.default.removeItem(at: dir) }
    let store = VaultAutoFillSnapshotStore(fileURL: dir.appendingPathComponent("cache.json"))
    try store.save(payload.snapshot)
    let keys = TestKeys(); keys.key = payload.rootKey
    let identities = TestIdentities(); identities.candidates = try store.listCandidates(rootKey: payload.rootKey)
    let controller = VaultAutoFillSyncController(snapshotStore: store, keys: keys, identities: identities)
    try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: dir.path)
    await #expect(throws: (any Error).self) { try await controller.disable() }
    #expect(keys.key == nil)
    #expect(identities.candidates.isEmpty)
}

@MainActor @Test("Disabled AutoFill provider never reports a successful publication")
func disabledProviderNeedsResync() async throws {
    let payload = try cachedPayload()
    let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: url) }
    let store = VaultAutoFillSnapshotStore(fileURL: url)
    let keys = TestKeys(); let identities = TestIdentities(); identities.isEnabled = false
    let controller = VaultAutoFillSyncController(snapshotStore: store, keys: keys, identities: identities)
    await #expect(throws: (any Error).self) { try await controller.synchronize(context: payload.snapshot.context) { payload } }
    #expect(identities.candidates.isEmpty)
    identities.isEnabled = true
    try await controller.synchronize(context: payload.snapshot.context) { payload }
    #expect(identities.candidates.count == 1)
}

@MainActor @Test("An oversized snapshot clears the offline cache without modifying the online payload")
func oversizedSnapshotClearsOfflineCache() async throws {
    let payload = try cachedPayload()
    let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let store = VaultAutoFillSnapshotStore(fileURL: url)
    defer { try? store.clear() }
    let keys = TestKeys()
    let identities = TestIdentities()
    let controller = VaultAutoFillSyncController(snapshotStore: store, keys: keys, identities: identities)
    try await controller.synchronize(context: payload.snapshot.context) { payload }
    let oversized = VaultAutoFillSyncPayload(
        snapshot: VaultAutoFillSnapshot(context: payload.snapshot.context, records: Array(repeating: payload.snapshot.records[0], count: 1_001)),
        rootKey: payload.rootKey
    )

    await #expect(throws: VaultNativeError.snapshotTooLarge) {
        try await controller.synchronize(context: payload.snapshot.context) { oversized }
    }
    #expect(oversized.snapshot.records.count == 1_001)
    #expect(!controller.hasOfflineSnapshot())
    #expect(keys.key == nil)
    #expect(identities.candidates.isEmpty)
}

@MainActor @Test("Cached unlock registers logins after AutoFill is enabled without rewriting the key")
func enablingProviderRegistersCachedLogins() async throws {
    let payload = try cachedPayload()
    let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let store = VaultAutoFillSnapshotStore(fileURL: url)
    defer { try? store.clear() }
    let keys = TestKeys()
    let identities = TestIdentities()
    identities.isEnabled = false
    let controller = VaultAutoFillSyncController(snapshotStore: store, keys: keys, identities: identities)
    await #expect(throws: VaultNativeError.providerDisabled) {
        try await controller.synchronize(context: payload.snapshot.context) { payload }
    }
    identities.isEnabled = true
    try await controller.registerCachedIdentities(payload)
    #expect(identities.candidates.map(\.username) == ["alice"])
    #expect(keys.saveCount == 1)
}
