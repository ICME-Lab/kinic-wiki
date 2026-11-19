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
