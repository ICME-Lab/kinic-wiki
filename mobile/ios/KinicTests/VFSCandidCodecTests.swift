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
        #expect(data.map { String(format: "%02x", $0) }.joined() == "4449444c016c02a5cbc7d204719f9bbd940a710100082f536f75726365730764625f64656d6f")
    }

    @Test
    func encodesAuthorizeSourceCaptureTriggerSessionRequest() {
        let data = VFSCandidEncoder.authorizeSourceCaptureTriggerSession(databaseId: "db_demo", sessionNonce: "session-nonce-1")
        #expect(data.map { String(format: "%02x", $0) }.joined() == "4449444c016c0286a09bb905719f9bbd940a7101000f73657373696f6e2d6e6f6e63652d310764625f64656d6f")
    }

    @Test
    func encodesWriteNodeRequest() {
        let request = SourceCaptureRequest(
            databaseId: "db_demo",
            requestId: "req_1",
            requestPath: "/Sources/page.md",
            content: "hello world",
            metadataJson: "{\"a\":1}",
            normalizedURL: URL(string: "https://example.com")!
        )
        let data = VFSCandidEncoder.writeNode(request)
        #expect(data.map { String(format: "%02x", $0) }.joined() == "4449444c036b03ced593f1027f9cf5d3f4027ffbc998b6067f6e716c06b99adecb0171d4c2a7b80400a5cbc7d20471fcc2a1eb0601b8c8dc8509719f9bbd940a7101020b68656c6c6f20776f726c6401102f536f75726365732f706167652e6d6400077b2261223a317d0764625f64656d6f")
    }

    @Test
    func encodesWriteNodesRequest() {
        let request = SourceCaptureRequest(
            databaseId: "db_demo",
            requestId: "req_1",
            requestPath: "/Sources/source-capture-requests/req_1.md",
            content: "kind: kinic.source_capture_request",
            metadataJson: "{\"request_type\":\"source_capture\"}",
            normalizedURL: URL(string: "https://example.com")!
        )
        let data = VFSCandidEncoder.writeNodes(request)
        #expect(data.starts(with: Data([0x44, 0x49, 0x44, 0x4c])))
        #expect(data.range(of: Data("db_demo".utf8)) != nil)
        #expect(data.range(of: Data("/Sources/source-capture-requests/req_1.md".utf8)) != nil)
        #expect(data.range(of: Data("kind: kinic.source_capture_request".utf8)) != nil)
    }

    @Test
    func encodesReadNodeArgs() {
        let data = VFSCandidEncoder.readNode(databaseId: "db_demo", path: "/Sources/request.md")
        #expect(data.starts(with: Data([0x44, 0x49, 0x44, 0x4c])))
        #expect(String(data: data.dropLast(20).suffix(7), encoding: .utf8) == "db_demo")
        #expect(String(data: data.suffix(19), encoding: .utf8) == "/Sources/request.md")
    }

    @Test
    func encodesListChildrenRequest() {
        let data = VFSCandidEncoder.listChildren(databaseId: "db_demo", path: "/Knowledge")
        #expect(data.starts(with: Data([0x44, 0x49, 0x44, 0x4c])))
        #expect(data.range(of: Data("/Knowledge".utf8)) != nil)
        #expect(data.range(of: Data("db_demo".utf8)) != nil)
    }

    @Test
    func encodesSearchNodesRequest() {
        let data = VFSCandidEncoder.searchNodes(databaseId: "db_demo", query: "swift auth", prefix: nil, topK: 20)
        #expect(data.starts(with: Data([0x44, 0x49, 0x44, 0x4c])))
        #expect(data.range(of: Data("db_demo".utf8)) != nil)
        #expect(data.range(of: Data("swift auth".utf8)) != nil)
    }

    @Test
    func encodesCreateDatabaseRequest() {
        let data = VFSCandidEncoder.createDatabase(name: "Team skills")
        #expect(data.map { String(format: "%02x", $0) }.joined() == "4449444c016c01cbe4fdc7047101000b5465616d20736b696c6c73")
    }

    @Test
    func encodesUpdateDatabaseMetadataRequest() {
        let data = VFSCandidEncoder.updateDatabaseMetadata(
            databaseId: "db_demo",
            name: "Team DB",
            description: "Team description",
            llmSummary: nil,
            tagsJson: "[\"swift\",\"日本語\"]"
        )
        #expect(data.map { String(format: "%02x", $0) }.joined() == "4449444c026e716c0594d7ab4500cbe4fdc70471fc91f4f805719f9bbd940a718eed9d890f71010100075465616d204442105465616d206465736372697074696f6e0764625f64656d6f155b227377696674222c22e697a5e69cace8aa9e225d")
    }

    @Test
    func encodesGrantDatabaseAccessRequest() {
        let principal = "aaaaa-aa"
        let data = VFSCandidEncoder.grantDatabaseAccess(databaseId: "db_demo", principal: principal, role: .writer)
        #expect(data.starts(with: Data([0x44, 0x49, 0x44, 0x4c])))
        #expect(data.range(of: Data("db_demo".utf8)) != nil)
        #expect(data.range(of: Data(principal.utf8)) != nil)
    }

    @Test
    func encodesRevokeDatabaseAccessRequest() {
        let principal = "aaaaa-aa"
        let data = VFSCandidEncoder.revokeDatabaseAccess(databaseId: "db_demo", principal: principal)
        #expect(data.starts(with: Data([0x44, 0x49, 0x44, 0x4c])))
        #expect(data.range(of: Data("db_demo".utf8)) != nil)
        #expect(data.range(of: Data(principal.utf8)) != nil)
    }

    @Test
    func encodesListDatabaseCycleEntriesRequest() {
        let data = VFSCandidEncoder.listDatabaseCycleEntries(databaseId: "db_demo", cursor: 12, limit: 20)
        #expect(data.starts(with: Data([0x44, 0x49, 0x44, 0x4c])))
        #expect(data.range(of: Data("db_demo".utf8)) != nil)
        #expect(data.suffix(4) == Data([20, 0, 0, 0]))
    }

    @Test
    func encodesMarketListEntitlementsRequest() {
        let withoutCursor = VFSCandidEncoder.marketListEntitlements(cursor: nil, limit: 100)
        #expect(withoutCursor.starts(with: Data([0x44, 0x49, 0x44, 0x4c])))
        #expect(withoutCursor.suffix(5) == Data([0, 100, 0, 0, 0]))

        let withCursor = VFSCandidEncoder.marketListEntitlements(cursor: "cursor-1", limit: 100)
        #expect(withCursor.starts(with: Data([0x44, 0x49, 0x44, 0x4c])))
        #expect(withCursor.range(of: Data("cursor-1".utf8)) != nil)
        #expect(withCursor.suffix(4) == Data([100, 0, 0, 0]))
    }

    @Test
    func encodesDeleteDatabaseRequest() {
        let data = VFSCandidEncoder.deleteDatabase(databaseId: "db_demo")
        #expect(data.starts(with: Data([0x44, 0x49, 0x44, 0x4c])))
        #expect(data.range(of: Data("db_demo".utf8)) != nil)
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
        #expect(databases[0].logicalSizeBytes == 1024)
        #expect(databases[0].cyclesBalance == 1_500_000_000_000)
        #expect(databases[0].cyclesSuspendedAtMs == nil)
        #expect(databases[0].deletedAtMs == nil)
        #expect(databases[1].databaseId == "db_writer")
        #expect(databases[1].title == "Writer Metadata")
        #expect(databases[1].description == "Writer description")
        #expect(databases[1].metadata?.name == "Writer Metadata")
        #expect(databases[1].metadata?.description == "Writer description")
        #expect(databases[1].metadata?.llmSummary == "Writer summary")
        #expect(databases[1].metadata?.tagsJson == "[\"swift\",\"ios\"]")
        #expect(databases[1].role == .writer)
        #expect(databases[1].logicalSizeBytes == 2_048)
        #expect(databases[1].cyclesBalance == 10)
        #expect(databases[1].cyclesSuspendedAtMs == 1_700_000_000_000)
        #expect(databases[2].databaseId == "db_owner")
        #expect(databases[2].title == "Owner Top")
        #expect(databases[2].description == "")
        #expect(databases[2].role == .owner)
        #expect(databases[2].logicalSizeBytes == 4_096)
        #expect(databases[2].cyclesBalance == nil)
        #expect(databases.filter(\.canRead).map(\.databaseId) == ["db_reader", "db_writer", "db_owner"])
        #expect(databases.filter(\.canWrite).map(\.databaseId) == ["db_writer", "db_owner"])
    }

    @Test
    func decodesDatabaseMetadataResult() throws {
        let metadata = try VFSCandidDecoder.decodeDatabaseMetadataResult(candidDatabaseMetadataOk(
            name: "Team DB",
            description: "Team description",
            llmSummary: "Team summary",
            tagsJson: "[\"swift\",\"日本語\"]"
        ))
        #expect(metadata.name == "Team DB")
        #expect(metadata.description == "Team description")
        #expect(metadata.llmSummary == "Team summary")
        #expect(metadata.tagsJson == "[\"swift\",\"日本語\"]")
    }

    @Test
    func decodesCyclesBillingConfigResult() throws {
        let config = try VFSCandidDecoder.decodeCyclesBillingConfigResult(candidCyclesBillingConfigOk())
        #expect(config.kinicLedgerCanisterId == "ryjl3-tyaaa-aaaaa-aaaba-cai")
        #expect(config.billingAuthorityId == "aaaaa-aa")
        #expect(config.iapAuthorityId == "rrkah-fqaaa-aaaaa-aaaaq-cai")
        #expect(config.cyclesPerKinic == 234_500_000_000)
        #expect(config.minUpdateCycles == 1_000_000)
        #expect(config.topUp.enabled == true)
        #expect(config.topUp.launcherPrincipal == "xfug4-5qaaa-aaaak-afowa-cai")
        #expect(config.topUp.thresholdCycles == 2_000_000_000_000)
    }

    @Test
    func decodesDatabaseCycleEntryPageResult() throws {
        let page = try VFSCandidDecoder.decodeDatabaseCycleEntryPageResult(candidDatabaseCycleEntryPageOk())
        #expect(page.nextCursor == 42)
        #expect(page.entries.count == 2)
        #expect(page.entries[0].entryId == 7)
        #expect(page.entries[0].databaseId == "db_demo")
        #expect(page.entries[0].kind == "write_charge")
        #expect(page.entries[0].amountCycles == -1_000_000)
        #expect(page.entries[0].balanceAfterCycles == 233_000_000_000)
        #expect(page.entries[0].caller == "aaaaa-aa")
        #expect(page.entries[0].method == "write_node")
        #expect(page.entries[0].displayTitle == "write_node")
        #expect(page.entries[1].entryId == 8)
        #expect(page.entries[1].kind == "cycles_purchase")
        #expect(page.entries[1].displayTitle == "cycles_purchase")
        #expect(page.entries[1].amountCycles == 5_000_000)
        #expect(page.entries[1].ledgerBlockIndex == 99)
    }

    @Test
    func decodesMarketEntitlementPageResult() throws {
        let page = try VFSCandidDecoder.decodeMarketEntitlementPageResult(candidMarketEntitlementPageOk())
        #expect(page.nextCursor == "cursor-2")
        #expect(page.entitlements.count == 1)
        #expect(page.entitlements[0].databaseId == "db_market")
        #expect(page.entitlements[0].buyerPrincipal == "buyer")
        #expect(page.entitlements[0].listingId == "listing-1")
        #expect(page.entitlements[0].orderId == "order-1")
        #expect(page.entitlements[0].purchasedAtMs == 123)
        #expect(page.entitlements[0].status == "active")
    }

    @Test
    func rejectsCyclesBillingConfigNatOverflow() throws {
        let overflowNat = Data(repeating: 0x80, count: 9) + Data([0x02])
        #expect(throws: VFSCandidError.invalidPayload("unsigned LEB128 is too large")) {
            try VFSCandidDecoder.decodeCyclesBillingConfigResult(candidCyclesBillingConfigOk(thresholdCyclesPayload: overflowNat))
        }
    }

    @Test
    func decodesChildNodesFromListChildrenResult() throws {
        let children = try VFSCandidDecoder.decodeChildNodesResult(candidChildNodesOk())
        #expect(children.count == 3)
        #expect(children[0].path == "/Knowledge/Design")
        #expect(children[0].name == "Design")
        #expect(children[0].kind == .folder)
        #expect(children[0].hasChildren == true)
        #expect(children[0].updatedAt == 30)
        #expect(children[1].path == "/Knowledge/README.md")
        #expect(children[1].kind == .file)
        #expect(children[1].etag == "etag_file")
        #expect(children[1].sizeBytes == 128)
        #expect(children[2].path == "/Sources/web/source.md")
        #expect(children[2].kind == .source)
        #expect(children[2].etag == "etag_source")
    }

    @Test
    func decodesSearchNodeHitsResult() throws {
        let hits = try VFSCandidDecoder.decodeSearchNodeHitsResult(candidSearchHitsOk())
        #expect(hits.count == 1)
        #expect(hits[0].path == "/Knowledge/README.md")
        #expect(hits[0].kind == .file)
        #expect(hits[0].snippet == "Swift auth snippet")
        #expect(hits[0].previewExcerpt == "Swift auth preview")
        #expect(hits[0].matchReasons == ["content"])
        #expect(hits[0].score > 0.89)
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

    @Test
    func decodesWriteNodesResult() throws {
        try VFSCandidDecoder.decodeWriteNodesResult(candidWriteNodesOk())
    }
}

private func candidWriteNodesOk() -> Data {
    enum Ref {
        case primitive(Int64)
        case table(Int64)
    }

    let typeText: Int64 = -15
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

    func appendVariantValue(_ selected: String, cases: [String]) {
        let sorted = cases.sorted { label($0) < label($1) }
        guard let index = sorted.firstIndex(of: selected) else {
            preconditionFailure("unknown fixture variant case")
        }
        appendUnsigned(UInt64(index), to: &data)
    }

    appendUnsigned(3, to: &data)
    appendVariant([
        ("Ok", .table(1)),
        ("Err", .primitive(typeText))
    ])
    appendSigned(typeVec, to: &data)
    appendSigned(2, to: &data)
    appendRecord([])

    appendUnsigned(1, to: &data)
    appendSigned(0, to: &data)
    appendVariantValue("Ok", cases: ["Ok", "Err"])
    appendUnsigned(1, to: &data)
    return data
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

private func candidDatabaseMetadataOk(name: String, description: String, llmSummary: String?, tagsJson: String) -> Data {
    enum Ref {
        case primitive(Int64)
        case table(Int64)
    }

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

    func appendVariantValue(_ selected: String, cases: [String]) {
        let sorted = cases.sorted { label($0) < label($1) }
        guard let index = sorted.firstIndex(of: selected) else {
            preconditionFailure("unknown fixture variant case")
        }
        appendUnsigned(UInt64(index), to: &data)
    }

    func appendMetadata() {
        for field in fields([
            ("name", .primitive(typeText)),
            ("description", .primitive(typeText)),
            ("llm_summary", .table(2)),
            ("tags_json", .primitive(typeText))
        ]) {
            switch field.0 {
            case "name":
                appendText(name)
            case "description":
                appendText(description)
            case "llm_summary":
                if let llmSummary {
                    data.append(1)
                    appendText(llmSummary)
                } else {
                    data.append(0)
                }
            case "tags_json":
                appendText(tagsJson)
            default:
                preconditionFailure("unknown fixture metadata field")
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
        ("description", .primitive(typeText)),
        ("llm_summary", .table(2)),
        ("tags_json", .primitive(typeText))
    ])
    appendOpt(.primitive(typeText))

    appendUnsigned(1, to: &data)
    appendSigned(0, to: &data)
    appendVariantValue("Ok", cases: ["Ok", "Err"])
    appendMetadata()
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

    func appendMetadata(name: String, description: String, llmSummary: String?, tagsJson: String) {
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
                if let llmSummary {
                    data.append(1)
                    appendText(llmSummary)
                } else {
                    data.append(0)
                }
            case "tags_json":
                appendText(tagsJson)
            default:
                preconditionFailure("unknown fixture metadata field")
            }
        }
    }

    func appendSummary(
        databaseId: String,
        topLevelName: String,
        role: String,
        metadata: (name: String, description: String, llmSummary: String?, tagsJson: String)?,
        logicalSizeBytes: UInt64,
        cyclesBalance: UInt64?,
        cyclesSuspendedAtMs: Int64?,
        deletedAtMs: Int64?
    ) {
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
                appendNat64(logicalSizeBytes)
            case "database_id":
                appendText(databaseId)
            case "name":
                appendText(topLevelName)
            case "metadata":
                if let metadata {
                    data.append(1)
                    appendMetadata(name: metadata.name, description: metadata.description, llmSummary: metadata.llmSummary, tagsJson: metadata.tagsJson)
                } else {
                    data.append(0)
                }
            case "cycles_balance":
                if let cyclesBalance {
                    data.append(1)
                    appendNat64(cyclesBalance)
                } else {
                    data.append(0)
                }
            case "cycles_suspended_at_ms":
                if let cyclesSuspendedAtMs {
                    data.append(1)
                    appendInt64(cyclesSuspendedAtMs)
                } else {
                    data.append(0)
                }
            case "deleted_at_ms":
                if let deletedAtMs {
                    data.append(1)
                    appendInt64(deletedAtMs)
                } else {
                    data.append(0)
                }
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
    appendSummary(
        databaseId: "db_reader",
        topLevelName: "Reader Top",
        role: "Reader",
        metadata: nil,
        logicalSizeBytes: 1_024,
        cyclesBalance: 1_500_000_000_000,
        cyclesSuspendedAtMs: nil,
        deletedAtMs: nil
    )
    appendSummary(
        databaseId: "db_writer",
        topLevelName: "Writer Top",
        role: "Writer",
        metadata: (
            name: "Writer Metadata",
            description: "Writer description",
            llmSummary: "Writer summary",
            tagsJson: "[\"swift\",\"ios\"]"
        ),
        logicalSizeBytes: 2_048,
        cyclesBalance: 10,
        cyclesSuspendedAtMs: 1_700_000_000_000,
        deletedAtMs: nil
    )
    appendSummary(
        databaseId: "db_owner",
        topLevelName: "Owner Top",
        role: "Owner",
        metadata: nil,
        logicalSizeBytes: 4_096,
        cyclesBalance: nil,
        cyclesSuspendedAtMs: nil,
        deletedAtMs: nil
    )
    return data
}

private func candidCyclesBillingConfigOk(thresholdCyclesPayload: Data? = nil) -> Data {
    enum Ref {
        case primitive(Int64)
        case table(Int64)
    }

    let typeBool: Int64 = -2
    let typeNat: Int64 = -3
    let typeNat64: Int64 = -8
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

    func appendConfig() {
        for field in fields([
            ("billing_authority_id", .primitive(typeText)),
            ("iap_authority_id", .primitive(typeText)),
            ("kinic_ledger_canister_id", .primitive(typeText)),
            ("top_up", .table(2)),
            ("cycles_per_kinic", .primitive(typeNat64)),
            ("min_update_cycles", .primitive(typeNat64))
        ]) {
            switch field.0 {
            case "billing_authority_id":
                appendText("aaaaa-aa")
            case "iap_authority_id":
                appendText("rrkah-fqaaa-aaaaa-aaaaq-cai")
            case "kinic_ledger_canister_id":
                appendText("ryjl3-tyaaa-aaaaa-aaaba-cai")
            case "top_up":
                appendTopUp()
            case "cycles_per_kinic":
                appendNat64(234_500_000_000)
            case "min_update_cycles":
                appendNat64(1_000_000)
            default:
                preconditionFailure("unknown fixture config field")
            }
        }
    }

    func appendTopUp() {
        for field in fields([
            ("enabled", .primitive(typeBool)),
            ("threshold_cycles", .primitive(typeNat)),
            ("launcher_principal", .primitive(typeText))
        ]) {
            switch field.0 {
            case "enabled":
                data.append(1)
            case "threshold_cycles":
                if let thresholdCyclesPayload {
                    data.append(thresholdCyclesPayload)
                } else {
                    appendUnsigned(2_000_000_000_000, to: &data)
                }
            case "launcher_principal":
                appendText("xfug4-5qaaa-aaaak-afowa-cai")
            default:
                preconditionFailure("unknown fixture top_up field")
            }
        }
    }

    appendUnsigned(3, to: &data)
    appendVariant([
        ("Ok", .table(1)),
        ("Err", .primitive(typeText))
    ])
    appendRecord([
        ("billing_authority_id", .primitive(typeText)),
        ("iap_authority_id", .primitive(typeText)),
        ("kinic_ledger_canister_id", .primitive(typeText)),
        ("top_up", .table(2)),
        ("cycles_per_kinic", .primitive(typeNat64)),
        ("min_update_cycles", .primitive(typeNat64))
    ])
    appendRecord([
        ("enabled", .primitive(typeBool)),
        ("threshold_cycles", .primitive(typeNat)),
        ("launcher_principal", .primitive(typeText))
    ])

    appendUnsigned(1, to: &data)
    appendSigned(0, to: &data)
    appendVariantValue("Ok", cases: ["Ok", "Err"])
    appendConfig()
    return data
}

private func candidDatabaseCycleEntryPageOk() -> Data {
    enum Ref {
        case primitive(Int64)
        case table(Int64)
    }

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

    func appendInt64(_ value: Int64) {
        let unsigned = UInt64(bitPattern: value)
        for offset in 0..<8 {
            data.append(UInt8(truncatingIfNeeded: unsigned >> UInt64(offset * 8)))
        }
    }

    func appendNat64(_ value: UInt64) {
        for offset in 0..<8 {
            data.append(UInt8(truncatingIfNeeded: value >> UInt64(offset * 8)))
        }
    }

    func appendOptionalNat64(_ value: UInt64?) {
        if let value {
            data.append(1)
            appendNat64(value)
        } else {
            data.append(0)
        }
    }

    func appendOptionalText(_ value: String?) {
        if let value {
            data.append(1)
            appendText(value)
        } else {
            data.append(0)
        }
    }

    func appendVariantValue(_ selected: String, cases: [String]) {
        let sorted = cases.sorted { label($0) < label($1) }
        guard let index = sorted.firstIndex(of: selected) else {
            preconditionFailure("unknown fixture variant case")
        }
        appendUnsigned(UInt64(index), to: &data)
    }

    func appendEntry(
        entryId: UInt64,
        kind: String,
        amountCycles: Int64,
        balanceAfterCycles: UInt64,
        method: String?,
        ledgerBlockIndex: UInt64?
    ) {
        for field in fields([
            ("entry_id", .primitive(typeNat64)),
            ("database_id", .primitive(typeText)),
            ("kind", .primitive(typeText)),
            ("amount_cycles", .primitive(typeInt64)),
            ("balance_after_cycles", .primitive(typeNat64)),
            ("payment_amount_e8s", .table(4)),
            ("caller", .primitive(typeText)),
            ("method", .table(5)),
            ("cycles_delta", .table(4)),
            ("cycles_per_kinic", .table(4)),
            ("ledger_block_index", .table(4)),
            ("created_at_ms", .primitive(typeInt64))
        ]) {
            switch field.0 {
            case "entry_id":
                appendNat64(entryId)
            case "database_id":
                appendText("db_demo")
            case "kind":
                appendText(kind)
            case "amount_cycles":
                appendInt64(amountCycles)
            case "balance_after_cycles":
                appendNat64(balanceAfterCycles)
            case "payment_amount_e8s":
                appendOptionalNat64(nil)
            case "caller":
                appendText("aaaaa-aa")
            case "method":
                appendOptionalText(method)
            case "cycles_delta":
                appendOptionalNat64(nil)
            case "cycles_per_kinic":
                appendOptionalNat64(nil)
            case "ledger_block_index":
                appendOptionalNat64(ledgerBlockIndex)
            case "created_at_ms":
                appendInt64(1_700_000_000_000)
            default:
                preconditionFailure("unknown fixture cycle entry field")
            }
        }
    }

    appendUnsigned(6, to: &data)
    appendVariant([
        ("Ok", .table(1)),
        ("Err", .primitive(typeText))
    ])
    appendRecord([
        ("entries", .table(2)),
        ("next_cursor", .table(4))
    ])
    appendVec(.table(3))
    appendRecord([
        ("entry_id", .primitive(typeNat64)),
        ("database_id", .primitive(typeText)),
        ("kind", .primitive(typeText)),
        ("amount_cycles", .primitive(typeInt64)),
        ("balance_after_cycles", .primitive(typeNat64)),
        ("payment_amount_e8s", .table(4)),
        ("caller", .primitive(typeText)),
        ("method", .table(5)),
        ("cycles_delta", .table(4)),
        ("cycles_per_kinic", .table(4)),
        ("ledger_block_index", .table(4)),
        ("created_at_ms", .primitive(typeInt64))
    ])
    appendOpt(.primitive(typeNat64))
    appendOpt(.primitive(typeText))

    appendUnsigned(1, to: &data)
    appendSigned(0, to: &data)
    appendVariantValue("Ok", cases: ["Ok", "Err"])
    for field in fields([
        ("entries", .table(2)),
        ("next_cursor", .table(4))
    ]) {
        switch field.0 {
        case "entries":
            appendUnsigned(2, to: &data)
            appendEntry(
                entryId: 7,
                kind: "write_charge",
                amountCycles: -1_000_000,
                balanceAfterCycles: 233_000_000_000,
                method: "write_node",
                ledgerBlockIndex: nil
            )
            appendEntry(
                entryId: 8,
                kind: "cycles_purchase",
                amountCycles: 5_000_000,
                balanceAfterCycles: 233_005_000_000,
                method: nil,
                ledgerBlockIndex: 99
            )
        case "next_cursor":
            data.append(1)
            appendNat64(42)
        default:
            preconditionFailure("unknown fixture cycle page field")
        }
    }
    return data
}

private func candidChildNodesOk() -> Data {
    enum Ref {
        case primitive(Int64)
        case table(Int64)
    }

    let typeNull: Int64 = -1
    let typeBool: Int64 = -2
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

    func appendInt64(_ value: Int64) {
        let unsigned = UInt64(bitPattern: value)
        for offset in 0..<8 {
            data.append(UInt8(truncatingIfNeeded: unsigned >> UInt64(offset * 8)))
        }
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

    func appendChild(path: String, name: String, kind: String, updatedAt: Int64?, etag: String?, sizeBytes: UInt64?, hasChildren: Bool, isVirtual: Bool) {
        for field in fields([
            ("updated_at", .table(3)),
            ("etag", .table(5)),
            ("kind", .table(4)),
            ("name", .primitive(typeText)),
            ("size_bytes", .table(6)),
            ("path", .primitive(typeText)),
            ("has_children", .primitive(typeBool)),
            ("is_virtual", .primitive(typeBool))
        ]) {
            switch field.0 {
            case "updated_at":
                if let updatedAt {
                    data.append(1)
                    appendInt64(updatedAt)
                } else {
                    data.append(0)
                }
            case "etag":
                if let etag {
                    data.append(1)
                    appendText(etag)
                } else {
                    data.append(0)
                }
            case "kind":
                appendVariantValue(kind, cases: ["Folder", "File", "Source", "Directory"])
            case "name":
                appendText(name)
            case "size_bytes":
                if let sizeBytes {
                    data.append(1)
                    appendNat64(sizeBytes)
                } else {
                    data.append(0)
                }
            case "path":
                appendText(path)
            case "has_children":
                data.append(hasChildren ? 1 : 0)
            case "is_virtual":
                data.append(isVirtual ? 1 : 0)
            default:
                preconditionFailure("unknown fixture child field")
            }
        }
    }

    appendUnsigned(7, to: &data)
    appendVariant([
        ("Ok", .table(1)),
        ("Err", .primitive(typeText))
    ])
    appendVec(.table(2))
    appendRecord([
        ("updated_at", .table(3)),
        ("etag", .table(5)),
        ("kind", .table(4)),
        ("name", .primitive(typeText)),
        ("size_bytes", .table(6)),
        ("path", .primitive(typeText)),
        ("has_children", .primitive(typeBool)),
        ("is_virtual", .primitive(typeBool))
    ])
    appendOpt(.primitive(typeInt64))
    appendVariant([
        ("Folder", .primitive(typeNull)),
        ("File", .primitive(typeNull)),
        ("Source", .primitive(typeNull)),
        ("Directory", .primitive(typeNull))
    ])
    appendOpt(.primitive(typeText))
    appendOpt(.primitive(typeNat64))

    appendUnsigned(1, to: &data)
    appendSigned(0, to: &data)
    appendVariantValue("Ok", cases: ["Ok", "Err"])
    appendUnsigned(3, to: &data)
    appendChild(path: "/Knowledge/Design", name: "Design", kind: "Folder", updatedAt: 30, etag: nil, sizeBytes: nil, hasChildren: true, isVirtual: false)
    appendChild(path: "/Knowledge/README.md", name: "README.md", kind: "File", updatedAt: 40, etag: "etag_file", sizeBytes: 128, hasChildren: false, isVirtual: false)
    appendChild(path: "/Sources/web/source.md", name: "source.md", kind: "Source", updatedAt: 50, etag: "etag_source", sizeBytes: 256, hasChildren: false, isVirtual: false)
    return data
}

private func candidSearchHitsOk() -> Data {
    enum Ref {
        case primitive(Int64)
        case table(Int64)
    }

    let typeNull: Int64 = -1
    let typeNat32: Int64 = -7
    let typeFloat32: Int64 = -13
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

    func appendNat32(_ value: UInt32) {
        for offset in 0..<4 {
            data.append(UInt8(truncatingIfNeeded: value >> UInt32(offset * 8)))
        }
    }

    func appendFloat32(_ value: Float) {
        let bitPattern = value.bitPattern
        for offset in 0..<4 {
            data.append(UInt8(truncatingIfNeeded: bitPattern >> UInt32(offset * 8)))
        }
    }

    func appendVariantValue(_ selected: String, cases: [String]) {
        let sorted = cases.sorted { label($0) < label($1) }
        guard let index = sorted.firstIndex(of: selected) else {
            preconditionFailure("unknown fixture variant case")
        }
        appendUnsigned(UInt64(index), to: &data)
    }

    func appendPreview() {
        for field in fields([
            ("field", .table(5)),
            ("char_offset", .primitive(typeNat32)),
            ("match_reason", .primitive(typeText)),
            ("excerpt", .table(6))
        ]) {
            switch field.0 {
            case "field":
                appendVariantValue("Content", cases: ["Path", "Content"])
            case "char_offset":
                appendNat32(4)
            case "match_reason":
                appendText("content")
            case "excerpt":
                data.append(1)
                appendText("Swift auth preview")
            default:
                preconditionFailure("unknown fixture preview field")
            }
        }
    }

    func appendHit() {
        for field in fields([
            ("preview", .table(3)),
            ("kind", .table(7)),
            ("path", .primitive(typeText)),
            ("match_reasons", .table(8)),
            ("snippet", .table(6)),
            ("score", .primitive(typeFloat32))
        ]) {
            switch field.0 {
            case "preview":
                data.append(1)
                appendPreview()
            case "kind":
                appendVariantValue("File", cases: ["Folder", "File", "Source"])
            case "path":
                appendText("/Knowledge/README.md")
            case "match_reasons":
                appendUnsigned(1, to: &data)
                appendText("content")
            case "snippet":
                data.append(1)
                appendText("Swift auth snippet")
            case "score":
                appendFloat32(0.9)
            default:
                preconditionFailure("unknown fixture search hit field")
            }
        }
    }

    appendUnsigned(9, to: &data)
    appendVariant([
        ("Ok", .table(1)),
        ("Err", .primitive(typeText))
    ])
    appendVec(.table(2))
    appendRecord([
        ("preview", .table(3)),
        ("kind", .table(7)),
        ("path", .primitive(typeText)),
        ("match_reasons", .table(8)),
        ("snippet", .table(6)),
        ("score", .primitive(typeFloat32))
    ])
    appendOpt(.table(4))
    appendRecord([
        ("field", .table(5)),
        ("char_offset", .primitive(typeNat32)),
        ("match_reason", .primitive(typeText)),
        ("excerpt", .table(6))
    ])
    appendVariant([
        ("Path", .primitive(typeNull)),
        ("Content", .primitive(typeNull))
    ])
    appendOpt(.primitive(typeText))
    appendVariant([
        ("Folder", .primitive(typeNull)),
        ("File", .primitive(typeNull)),
        ("Source", .primitive(typeNull))
    ])
    appendVec(.primitive(typeText))

    appendUnsigned(1, to: &data)
    appendSigned(0, to: &data)
    appendVariantValue("Ok", cases: ["Ok", "Err"])
    appendUnsigned(1, to: &data)
    appendHit()
    return data
}

private func candidMarketEntitlementPageOk() -> Data {
    enum Ref {
        case primitive(Int64)
        case table(Int64)
    }

    let typeText: Int64 = -15
    let typeInt64: Int64 = -12
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

    func appendEntitlement() {
        for field in fields([
            ("status", .primitive(typeText)),
            ("purchased_at_ms", .primitive(typeInt64)),
            ("database_id", .primitive(typeText)),
            ("buyer_principal", .primitive(typeText)),
            ("order_id", .primitive(typeText)),
            ("listing_id", .primitive(typeText))
        ]) {
            switch field.0 {
            case "status":
                appendText("active")
            case "purchased_at_ms":
                appendInt64(123)
            case "database_id":
                appendText("db_market")
            case "buyer_principal":
                appendText("buyer")
            case "order_id":
                appendText("order-1")
            case "listing_id":
                appendText("listing-1")
            default:
                preconditionFailure("unknown fixture entitlement field")
            }
        }
    }

    func appendPage() {
        for field in fields([
            ("next_cursor", .table(2)),
            ("entitlements", .table(3))
        ]) {
            switch field.0 {
            case "next_cursor":
                data.append(1)
                appendText("cursor-2")
            case "entitlements":
                appendUnsigned(1, to: &data)
                appendEntitlement()
            default:
                preconditionFailure("unknown fixture entitlement page field")
            }
        }
    }

    appendUnsigned(5, to: &data)
    appendVariant([
        ("Ok", .table(1)),
        ("Err", .primitive(typeText))
    ])
    appendRecord([
        ("next_cursor", .table(2)),
        ("entitlements", .table(3))
    ])
    appendOpt(.primitive(typeText))
    appendVec(.table(4))
    appendRecord([
        ("status", .primitive(typeText)),
        ("purchased_at_ms", .primitive(typeInt64)),
        ("database_id", .primitive(typeText)),
        ("buyer_principal", .primitive(typeText)),
        ("order_id", .primitive(typeText)),
        ("listing_id", .primitive(typeText))
    ])

    appendUnsigned(1, to: &data)
    appendSigned(0, to: &data)
    appendVariantValue("Ok", cases: ["Ok", "Err"])
    appendPage()
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
