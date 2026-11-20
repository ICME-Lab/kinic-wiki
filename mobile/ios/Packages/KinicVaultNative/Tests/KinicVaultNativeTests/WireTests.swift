import Foundation
import ICNativeClient
import Testing
@testable import KinicVaultNative

@Test("Vault responses reject missing fields and deleted or malformed headers")
func rejectsInvalidHeaders() throws {
    let fields = [CandidField("id", type: .vector(.nat8))]
    let value = CandidValue.record(fields, [Candid.fieldID("id"): .blob(Data(repeating: 1, count: 16))])
    #expect(throws: (any Error).self) { _ = try VaultNativeHeader(value) }
}
@Test("Vault results reject errors instead of treating them as empty success")
func rejectsErrorResult() throws {
    let variant = try CandidVariant(fields: [CandidField("Err", type: .null)], tag: "Err", value: .null)
    #expect(throws: (any Error).self) { _ = try VaultWire.unwrap(.variant(variant)) }
}

@Test("Certified inactive Vault headers are access loss, not a transient parse error")
func inactiveHeaderRevokesAccess() throws {
    for state in ["Deleting", "Pending"] {
        let stateFields = ["Active", "Deleting", "Pending"].map { CandidField($0, type: .null) }
        let entries: [(String, CandidValue)] = [
            ("id", .blob(Data(repeating: 1, count: 16))), ("nonce", .blob(Data(repeating: 2, count: 32))),
            ("public_key", .blob(Data(repeating: 3, count: 96))), ("key_name", .text("key_1")),
            ("name", .optional(.text, nil)), ("sequence", .nat64(1)),
            ("state", .variant(try CandidVariant(fields: stateFields, tag: state, value: .null))),
        ]
        let value = CandidValue.record([], Dictionary(uniqueKeysWithValues: entries.map { (Candid.fieldID($0.0), $0.1) }))
        do { _ = try VaultNativeHeader(value); Issue.record("Inactive header accepted") }
        catch VaultNativeError.accessLost {} catch { Issue.record("Inactive header did not revoke access") }
    }
}

@Test("Missing objects remain distinct from missing Vault access")
func preservesNotFoundScope() throws {
    let error = try CandidVariant(fields: [CandidField("NotFound", type: .null)], tag: "NotFound", value: .null)
    let result = try CandidVariant(fields: [CandidField("Err", type: .variant(error.fields))], tag: "Err", value: .variant(error))
    do { _ = try VaultWire.unwrap(.variant(result)); Issue.record("Missing object accepted") }
    catch VaultNativeError.notFound {} catch { Issue.record("NotFound scope lost: \(error)") }
}

@MainActor @Test("A concurrently purged object revalidates Vault access and permits retry")
func missingObjectRevalidatesAccess() async throws {
    var headerReads = 0
    do {
        let _: Data = try await VaultWire.readSnapshotObject {
            throw VaultNativeError.notFound
        } revalidate: { headerReads += 1 }
        Issue.record("Missing object accepted")
    } catch VaultNativeError.changedDuringSync {} catch { Issue.record("Active Vault incorrectly lost: \(error)") }
    #expect(headerReads == 1)
    let chunk: Data = try await VaultWire.readSnapshotObject {
        Data([1, 2, 3])
    } revalidate: { Issue.record("Successful object read unexpectedly revalidated") }
    #expect(chunk == Data([1, 2, 3]))
}

@MainActor @Test("Missing Vault access and transient revalidation failures retain their meaning")
func missingObjectPreservesHeaderFailures() async throws {
    do {
        let _: Data = try await VaultWire.readSnapshotObject { throw VaultNativeError.notFound }
        revalidate: { throw VaultNativeError.accessLost }
        Issue.record("Lost Vault access accepted")
    } catch VaultNativeError.accessLost {} catch { Issue.record("Vault access failure hidden: \(error)") }
    do {
        let _: Data = try await VaultWire.readSnapshotObject { throw VaultNativeError.notFound }
        revalidate: { throw URLError(.notConnectedToInternet) }
        Issue.record("Network failure accepted")
    } catch let error as URLError { #expect(error.code == .notConnectedToInternet) }
    catch { Issue.record("Transient error incorrectly revoked access: \(error)") }
    do {
        let _: Data = try await VaultWire.readSnapshotObject { throw CancellationError() }
        revalidate: { Issue.record("Cancelled fetch unexpectedly revalidated") }
        Issue.record("Cancellation accepted")
    } catch is CancellationError {} catch { Issue.record("Cancellation hidden: \(error)") }
}

@Test("Vault mutation Candid builders encode SaveInline, DeleteObject, and RenameVault cleanly")
func encodesVaultMutations() throws {
    let vault = Data(repeating: 1, count: 16)
    let object = Data(repeating: 2, count: 16)
    let op = Data(repeating: 3, count: 16)
    let hash = Data(repeating: 4, count: 32)
    let saveArgs = try VaultWire.saveInlineArguments(
        vault: vault,
        object: object,
        expectedRevision: 0,
        requestOperation: op,
        plainSize: 42,
        manifest: Data("{}".utf8),
        chunkHashes: [hash],
        bytes: Data([1, 2, 3]),
        contextHash: hash,
        mutationOperation: op
    )
    #expect(saveArgs.values.count == 1)

    let deleteArgs = try VaultWire.deleteObjectArguments(
        vault: vault,
        object: object,
        expectedRevision: 1,
        mutationOperation: op
    )
    #expect(deleteArgs.values.count == 1)

    let renameArgs = try VaultWire.renameVaultArguments(
        vault: vault,
        name: "Personal",
        expectedSequence: 2,
        mutationOperation: op
    )
    #expect(renameArgs.values.count == 1)

    #expect(VaultNativeClient.isValidVaultName("Personal Vault"))
    #expect(!VaultNativeClient.isValidVaultName("   "))
    #expect(!VaultNativeClient.isValidVaultName("Bad\nName"))
}

@Test("Vault error unwrapping preserves Conflict and QuotaExceeded semantics")
func mapsSpecificCanisterErrors() throws {
    for (tag, expected): (String, VaultNativeError) in [
        ("Conflict", .conflict),
        ("QuotaExceeded", .quotaExceeded),
        ("InvalidInput", .invalidInput),
        ("Busy", .busy),
    ] {
        let errVariant = try CandidVariant(fields: [CandidField(tag, type: .null)], tag: tag, value: .null)
        let resultVariant = try CandidVariant(
            fields: [CandidField("Err", type: .variant(errVariant.fields))],
            tag: "Err",
            value: .variant(errVariant)
        )
        #expect(throws: expected) { _ = try VaultWire.unwrap(.variant(resultVariant)) }
    }
}

@Test("Inline reconciliation matches exact manifest and rejects deleted or tampered revisions")
func reconcilesExactInlineManifestOnly() throws {
    let vault = Data(repeating: 1, count: 16)
    let object = Data(repeating: 2, count: 16)
    let manifest = Data("{\"version\":3}".utf8)
    let hash = Data(repeating: 7, count: 32)
    func makeRevision(deleted: Bool = false, sequence: UInt64 = 5, manifestBytes: Data = manifest, hashes: [Data] = [hash]) -> CandidValue {
        let entries: [(String, CandidValue)] = [
            ("deleted", .bool(deleted)),
            ("vault", .blob(vault)),
            ("object", .blob(object)),
            ("revision", .nat64(1)),
            ("sequence", .nat64(sequence)),
            ("plain_size", .nat64(12)),
            ("manifest", .blob(manifestBytes)),
            ("chunk_hashes", hashes.candidValue),
        ]
        return .record([], Dictionary(uniqueKeysWithValues: entries.map { (Candid.fieldID($0.0), $0.1) }))
    }

    #expect(
        try VaultWire.matchesReconciledInlineManifest(
            makeRevision(),
            vault: vault,
            object: object,
            expectedNextRevision: 1,
            plainSize: 12,
            manifest: manifest,
            chunkHashes: [hash]
        ) == 5
    )
    #expect(
        try VaultWire.matchesReconciledInlineManifest(
            makeRevision(deleted: true),
            vault: vault,
            object: object,
            expectedNextRevision: 1,
            plainSize: 12,
            manifest: manifest,
            chunkHashes: [hash]
        ) == nil
    )
    #expect(
        try VaultWire.matchesReconciledInlineManifest(
            makeRevision(manifestBytes: Data("{\"version\":2}".utf8)),
            vault: vault,
            object: object,
            expectedNextRevision: 1,
            plainSize: 12,
            manifest: manifest,
            chunkHashes: [hash]
        ) == nil
    )
}
