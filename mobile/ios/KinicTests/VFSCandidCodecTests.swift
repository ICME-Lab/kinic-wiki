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
    func encodesReadNodeArgs() {
        let data = VFSCandidEncoder.readNode(databaseId: "db_demo", path: "/Sources/request.md")
        #expect(data.starts(with: Data([0x44, 0x49, 0x44, 0x4c])))
        #expect(String(data: data.dropLast(20).suffix(7), encoding: .utf8) == "db_demo")
        #expect(String(data: data.suffix(19), encoding: .utf8) == "/Sources/request.md")
    }

    @Test
    func encodesCreateDatabaseRequest() {
        let data = VFSCandidEncoder.createDatabase(name: "Team skills")
        #expect(data.starts(with: Data([0x44, 0x49, 0x44, 0x4c])))
        #expect(String(data: data.suffix(11), encoding: .utf8) == "Team skills")
    }

    @Test
    func decodesUnitResultErr() throws {
        #expect(throws: VFSCandidError.canisterRejected("denied")) {
            try VFSCandidDecoder.decodeUnitResult(candidResultErr("denied"))
        }
    }

    @Test
    func decodesMissingReadNodeResult() throws {
        let node = try VFSCandidDecoder.decodeReadNodeResult(candidReadNodeOk(node: nil))
        #expect(node == nil)
    }

    @Test
    func decodesReadNodeResult() throws {
        let node = try #require(try VFSCandidDecoder.decodeReadNodeResult(candidReadNodeOk(node: (
            path: "/Sources/source-capture-requests/request.md",
            kind: "File",
            content: "kind: kinic.source_capture_request",
            metadataJson: "{\"request_type\":\"source_capture\",\"url\":\"https://example.com/page\"}",
            etag: "etag_1"
        ))))
        #expect(node.path == "/Sources/source-capture-requests/request.md")
        #expect(node.kind == .file)
        #expect(node.content == "kind: kinic.source_capture_request")
        #expect(node.metadataJson == "{\"request_type\":\"source_capture\",\"url\":\"https://example.com/page\"}")
        #expect(node.etag == "etag_1")
    }

    @Test
    func decodesDatabaseSummariesFromListDatabasesResult() throws {
        let databases = try VFSCandidDecoder.decodeDatabaseSummaries(candidDatabaseSummariesOk())
        #expect(databases.count == 3)
        #expect(databases[0].databaseId == "db_reader")
        #expect(databases[0].title == "Reader Top")
        #expect(databases[0].description == "")
        #expect(databases[0].role == .reader)
        #expect(databases[1].databaseId == "db_writer")
        #expect(databases[1].title == "Writer Metadata")
        #expect(databases[1].description == "Writer description")
        #expect(databases[1].role == .writer)
        #expect(databases[2].databaseId == "db_owner")
        #expect(databases[2].title == "Owner Top")
        #expect(databases[2].description == "")
        #expect(databases[2].role == .owner)
        #expect(databases.filter(\.canWrite).map(\.databaseId) == ["db_writer", "db_owner"])
    }

    @Test
    func decodesActiveCreateDatabaseResult() throws {
        let database = try VFSCandidDecoder.decodeCreateDatabaseResult(candidCreateDatabaseOk(status: "Active", initialFreeGrantApplied: true))
        #expect(database.databaseId == "db_created")
        #expect(database.name == "Team skills")
        #expect(database.status == .active)
        #expect(database.initialFreeGrantApplied == true)
    }

    @Test
    func decodesPendingCreateDatabaseResult() throws {
        let database = try VFSCandidDecoder.decodeCreateDatabaseResult(candidCreateDatabaseOk(status: "Pending", initialFreeGrantApplied: false))
        #expect(database.status == .pending)
        #expect(database.initialFreeGrantApplied == false)
    }

    @Test
    func decodesCreateDatabaseErr() throws {
        #expect(throws: VFSCandidError.canisterRejected("database limit reached")) {
            try VFSCandidDecoder.decodeCreateDatabaseResult(candidResultErr("database limit reached"))
        }
    }
}

private func candidCreateDatabaseOk(status: String, initialFreeGrantApplied: Bool) -> Data {
    enum Ref {
        case primitive(Int64)
        case table(Int64)
    }

    let typeNull: Int64 = -1
    let typeBool: Int64 = -2
    let typeText: Int64 = -15
    let typeRecord: Int64 = -20
    let typeVariant: Int64 = -21

    var data = Data([0x44, 0x49, 0x44, 0x4c])

    func label(_ name: String) -> UInt32 {
        VFSCandidLabels.id(name)
    }

    func fields(_ raw: [(String, Ref)]) -> [(String, Ref)] {
        raw.sorted { label($0.0) < label($1.0) }
    }

    func appendRef(_ ref: Ref) {
        switch ref {
        case .primitive(let type):
            appendSigned(type, to: &data)
        case .table(let index):
            appendSigned(index, to: &data)
        }
    }

    func appendFields(_ raw: [(String, Ref)]) {
        let sorted = fields(raw)
        appendUnsigned(UInt64(sorted.count), to: &data)
        for field in sorted {
            appendUnsigned(UInt64(label(field.0)), to: &data)
            appendRef(field.1)
        }
    }

    func appendRecord(_ raw: [(String, Ref)]) {
        appendSigned(typeRecord, to: &data)
        appendFields(raw)
    }

    func appendVariant(_ raw: [(String, Ref)]) {
        appendSigned(typeVariant, to: &data)
        appendFields(raw)
    }

    func appendText(_ text: String) {
        let bytes = Data(text.utf8)
        appendUnsigned(UInt64(bytes.count), to: &data)
        data.append(bytes)
    }

    func appendVariantValue(_ selected: String, cases: [String]) {
        let sorted = cases.sorted { label($0) < label($1) }
        guard let index = sorted.firstIndex(of: selected) else {
            preconditionFailure("unknown fixture variant case")
        }
        appendUnsigned(UInt64(index), to: &data)
    }

    func appendCreatedDatabase() {
        for field in fields([
            ("name", .primitive(typeText)),
            ("database_id", .primitive(typeText)),
            ("status", .table(2)),
            ("initial_free_grant_applied", .primitive(typeBool))
        ]) {
            switch field.0 {
            case "name":
                appendText("Team skills")
            case "database_id":
                appendText("db_created")
            case "status":
                appendVariantValue(status, cases: ["Active", "Deleted", "Pending"])
            case "initial_free_grant_applied":
                data.append(initialFreeGrantApplied ? 1 : 0)
            default:
                preconditionFailure("unknown fixture create_database field")
            }
        }
    }

    appendUnsigned(3, to: &data)
    appendVariant([
        ("Ok", .table(1)),
        ("Err", .primitive(typeText))
    ])
    appendRecord([
        ("name", .primitive(typeText)),
        ("database_id", .primitive(typeText)),
        ("status", .table(2)),
        ("initial_free_grant_applied", .primitive(typeBool))
    ])
    appendVariant([
        ("Active", .primitive(typeNull)),
        ("Deleted", .primitive(typeNull)),
        ("Pending", .primitive(typeNull))
    ])

    appendUnsigned(1, to: &data)
    appendSigned(0, to: &data)
    appendVariantValue("Ok", cases: ["Ok", "Err"])
    appendCreatedDatabase()
    return data
}

private func candidReadNodeOk(node: (path: String, kind: String, content: String, metadataJson: String, etag: String)?) -> Data {
    enum Ref {
        case primitive(Int64)
        case table(Int64)
    }

    let typeNull: Int64 = -1
    let typeInt64: Int64 = -12
    let typeText: Int64 = -15
    let typeOpt: Int64 = -18
    let typeRecord: Int64 = -20
    let typeVariant: Int64 = -21

    var data = Data([0x44, 0x49, 0x44, 0x4c])

    func label(_ name: String) -> UInt32 {
        VFSCandidLabels.id(name)
    }

    func fields(_ raw: [(String, Ref)]) -> [(String, Ref)] {
        raw.sorted { label($0.0) < label($1.0) }
    }

    func appendRef(_ ref: Ref) {
        switch ref {
        case .primitive(let type):
            appendSigned(type, to: &data)
        case .table(let index):
            appendSigned(index, to: &data)
        }
    }

    func appendFields(_ raw: [(String, Ref)]) {
        let sorted = fields(raw)
        appendUnsigned(UInt64(sorted.count), to: &data)
        for field in sorted {
            appendUnsigned(UInt64(label(field.0)), to: &data)
            appendRef(field.1)
        }
    }

    func appendRecord(_ raw: [(String, Ref)]) {
        appendSigned(typeRecord, to: &data)
        appendFields(raw)
    }

    func appendVariant(_ raw: [(String, Ref)]) {
        appendSigned(typeVariant, to: &data)
        appendFields(raw)
    }

    func appendOpt(_ ref: Ref) {
        appendSigned(typeOpt, to: &data)
        appendRef(ref)
    }

    func appendText(_ text: String) {
        let bytes = Data(text.utf8)
        appendUnsigned(UInt64(bytes.count), to: &data)
        data.append(bytes)
    }

    func appendInt64(_ value: Int64) {
        let unsigned = UInt64(bitPattern: value)
        for offset in 0..<8 {
            data.append(UInt8(truncatingIfNeeded: unsigned >> UInt64(offset * 8)))
        }
    }

    func appendVariantValue(_ selected: String, cases: [String]) {
        let sorted = cases.sorted { label($0) < label($1) }
        guard let index = sorted.firstIndex(of: selected) else {
            preconditionFailure("unknown fixture variant case")
        }
        appendUnsigned(UInt64(index), to: &data)
    }

    func appendNode(_ node: (path: String, kind: String, content: String, metadataJson: String, etag: String)) {
        for field in fields([
            ("updated_at", .primitive(typeInt64)),
            ("content", .primitive(typeText)),
            ("etag", .primitive(typeText)),
            ("kind", .table(3)),
            ("path", .primitive(typeText)),
            ("created_at", .primitive(typeInt64)),
            ("metadata_json", .primitive(typeText))
        ]) {
            switch field.0 {
            case "updated_at":
                appendInt64(20)
            case "content":
                appendText(node.content)
            case "etag":
                appendText(node.etag)
            case "kind":
                appendVariantValue(node.kind, cases: ["File", "Source", "Folder"])
            case "path":
                appendText(node.path)
            case "created_at":
                appendInt64(10)
            case "metadata_json":
                appendText(node.metadataJson)
            default:
                preconditionFailure("unknown fixture node field")
            }
        }
    }

    appendUnsigned(4, to: &data)
    appendVariant([
        ("Ok", .table(1)),
        ("Err", .primitive(typeText))
    ])
    appendOpt(.table(2))
    appendRecord([
        ("updated_at", .primitive(typeInt64)),
        ("content", .primitive(typeText)),
        ("etag", .primitive(typeText)),
        ("kind", .table(3)),
        ("path", .primitive(typeText)),
        ("created_at", .primitive(typeInt64)),
        ("metadata_json", .primitive(typeText))
    ])
    appendVariant([
        ("Folder", .primitive(typeNull)),
        ("File", .primitive(typeNull)),
        ("Source", .primitive(typeNull))
    ])

    appendUnsigned(1, to: &data)
    appendSigned(0, to: &data)
    appendVariantValue("Ok", cases: ["Ok", "Err"])
    if let node {
        data.append(1)
        appendNode(node)
    } else {
        data.append(0)
    }
    return data
}

private func candidDatabaseSummariesOk() -> Data {
    enum Ref {
        case primitive(Int64)
        case table(Int64)
    }

    let typeNull: Int64 = -1
    let typeNat64: Int64 = -8
    let typeInt64: Int64 = -12
    let typeText: Int64 = -15
    let typeOpt: Int64 = -18
    let typeVec: Int64 = -19
    let typeRecord: Int64 = -20
    let typeVariant: Int64 = -21

    var data = Data([0x44, 0x49, 0x44, 0x4c])

    func label(_ name: String) -> UInt32 {
        VFSCandidLabels.id(name)
    }

    func fields(_ raw: [(String, Ref)]) -> [(String, Ref)] {
        raw.sorted { label($0.0) < label($1.0) }
    }

    func appendRef(_ ref: Ref) {
        switch ref {
        case .primitive(let type):
            appendSigned(type, to: &data)
        case .table(let index):
            appendSigned(index, to: &data)
        }
    }

    func appendFields(_ raw: [(String, Ref)]) {
        let sorted = fields(raw)
        appendUnsigned(UInt64(sorted.count), to: &data)
        for field in sorted {
            appendUnsigned(UInt64(label(field.0)), to: &data)
            appendRef(field.1)
        }
    }

    func appendRecord(_ raw: [(String, Ref)]) {
        appendSigned(typeRecord, to: &data)
        appendFields(raw)
    }

    func appendVariant(_ raw: [(String, Ref)]) {
        appendSigned(typeVariant, to: &data)
        appendFields(raw)
    }

    func appendOpt(_ ref: Ref) {
        appendSigned(typeOpt, to: &data)
        appendRef(ref)
    }

    func appendVec(_ ref: Ref) {
        appendSigned(typeVec, to: &data)
        appendRef(ref)
    }

    func appendText(_ text: String) {
        let bytes = Data(text.utf8)
        appendUnsigned(UInt64(bytes.count), to: &data)
        data.append(bytes)
    }

    func appendNat64(_ value: UInt64) {
        for offset in 0..<8 {
            data.append(UInt8(truncatingIfNeeded: value >> UInt64(offset * 8)))
        }
    }

    func appendVariantValue(_ selected: String, cases: [String]) {
        let sorted = cases.sorted { label($0) < label($1) }
        guard let index = sorted.firstIndex(of: selected) else {
            preconditionFailure("unknown fixture variant case")
        }
        appendUnsigned(UInt64(index), to: &data)
    }

    func appendMetadata(name: String, description: String) {
        for field in fields([
            ("name", .primitive(typeText)),
            ("description", .primitive(typeText)),
            ("llm_summary", .table(6)),
            ("tags_json", .primitive(typeText))
        ]) {
            switch field.0 {
            case "name":
                appendText(name)
            case "description":
                appendText(description)
            case "llm_summary":
                data.append(0)
            case "tags_json":
                appendText("[]")
            default:
                preconditionFailure("unknown fixture metadata field")
            }
        }
    }

    func appendSummary(databaseId: String, topLevelName: String, role: String, metadata: (String, String)?) {
        for field in fields([
            ("status", .table(3)),
            ("role", .table(7)),
            ("logical_size_bytes", .primitive(typeNat64)),
            ("database_id", .primitive(typeText)),
            ("name", .primitive(typeText)),
            ("metadata", .table(4)),
            ("cycles_balance", .table(8)),
            ("cycles_suspended_at_ms", .table(9)),
            ("deleted_at_ms", .table(9))
        ]) {
            switch field.0 {
            case "status":
                appendVariantValue("Active", cases: ["Active", "Deleted", "Pending"])
            case "role":
                appendVariantValue(role, cases: ["Reader", "Writer", "Owner"])
            case "logical_size_bytes":
                appendNat64(0)
            case "database_id":
                appendText(databaseId)
            case "name":
                appendText(topLevelName)
            case "metadata":
                if let metadata {
                    data.append(1)
                    appendMetadata(name: metadata.0, description: metadata.1)
                } else {
                    data.append(0)
                }
            case "cycles_balance", "cycles_suspended_at_ms", "deleted_at_ms":
                data.append(0)
            default:
                preconditionFailure("unknown fixture summary field")
            }
        }
    }

    appendUnsigned(10, to: &data)
    appendVariant([
        ("Ok", .table(1)),
        ("Err", .primitive(typeText))
    ])
    appendVec(.table(2))
    appendRecord([
        ("status", .table(3)),
        ("role", .table(7)),
        ("logical_size_bytes", .primitive(typeNat64)),
        ("database_id", .primitive(typeText)),
        ("name", .primitive(typeText)),
        ("metadata", .table(4)),
        ("cycles_balance", .table(8)),
        ("cycles_suspended_at_ms", .table(9)),
        ("deleted_at_ms", .table(9))
    ])
    appendVariant([
        ("Active", .primitive(typeNull)),
        ("Deleted", .primitive(typeNull)),
        ("Pending", .primitive(typeNull))
    ])
    appendOpt(.table(5))
    appendRecord([
        ("name", .primitive(typeText)),
        ("description", .primitive(typeText)),
        ("llm_summary", .table(6)),
        ("tags_json", .primitive(typeText))
    ])
    appendOpt(.primitive(typeText))
    appendVariant([
        ("Reader", .primitive(typeNull)),
        ("Writer", .primitive(typeNull)),
        ("Owner", .primitive(typeNull))
    ])
    appendOpt(.primitive(typeNat64))
    appendOpt(.primitive(typeInt64))

    appendUnsigned(1, to: &data)
    appendSigned(0, to: &data)
    appendVariantValue("Ok", cases: ["Ok", "Err"])
    appendUnsigned(3, to: &data)
    appendSummary(databaseId: "db_reader", topLevelName: "Reader Top", role: "Reader", metadata: nil)
    appendSummary(databaseId: "db_writer", topLevelName: "Writer Top", role: "Writer", metadata: ("Writer Metadata", "Writer description"))
    appendSummary(databaseId: "db_owner", topLevelName: "Owner Top", role: "Owner", metadata: nil)
    return data
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
