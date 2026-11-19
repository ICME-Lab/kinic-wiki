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
