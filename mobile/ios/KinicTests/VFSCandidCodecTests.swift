// Where: mobile/ios/KinicTests/VFSCandidCodecTests.swift
// What: Golden tests for the VFS-only Candid codec.
// Why: Native source capture depends on exact canister wire shapes.

import Foundation
import Testing
@testable import Kinic

struct VFSCandidCodecTests {
    @Test
    func encodesEmptyArgsForListDatabases() {
        #expect(VFSCandidEncoder.empty().map { String(format: "%02x", $0) }.joined() == "4449444c0000")
    }

    @Test
    func encodesMkdirNodeRequest() {
        let data = VFSCandidEncoder.mkdirNode(databaseId: "db_demo", path: "/Sources")
        #expect(data.starts(with: Data([0x44, 0x49, 0x44, 0x4c])))
        #expect(String(data: data.suffix(16), encoding: .utf8)?.contains("db_demo") == true)
    }

    @Test
    func decodesUnitResultErr() throws {
        #expect(throws: VFSCandidError.canisterRejected("denied")) {
            try VFSCandidDecoder.decodeUnitResult(candidResultErr("denied"))
        }
    }

    @Test
    func keepsOnlyWritableDatabases() {
        let databases = [
            DatabaseSummary(databaseId: "db_reader", title: "Reader", description: "", role: .reader, status: .active),
            DatabaseSummary(databaseId: "db_writer", title: "Writer", description: "", role: .writer, status: .active),
            DatabaseSummary(databaseId: "db_owner", title: "Owner", description: "", role: .owner, status: .active),
            DatabaseSummary(databaseId: "db_deleted", title: "Deleted", description: "", role: .owner, status: .deleted)
        ]
        #expect(databases.filter(\.canWrite).map(\.databaseId) == ["db_writer", "db_owner"])
    }
}

private func candidResultErr(_ message: String) -> Data {
    var data = Data([0x44, 0x49, 0x44, 0x4c])
    appendUnsigned(1, to: &data)
    appendSigned(-21, to: &data)
    appendUnsigned(2, to: &data)
    appendUnsigned(UInt64(VFSCandidLabels.id("Ok")), to: &data)
    appendSigned(-1, to: &data)
    appendUnsigned(UInt64(VFSCandidLabels.id("Err")), to: &data)
    appendSigned(-15, to: &data)
    appendUnsigned(1, to: &data)
    appendSigned(0, to: &data)
    appendUnsigned(1, to: &data)
    let bytes = Data(message.utf8)
    appendUnsigned(UInt64(bytes.count), to: &data)
    data.append(bytes)
    return data
}

private func appendUnsigned(_ value: UInt64, to data: inout Data) {
    VFSCandidLEB.appendUnsigned(value, to: &data)
}

private func appendSigned(_ value: Int64, to data: inout Data) {
    VFSCandidLEB.appendSigned(value, to: &data)
}
