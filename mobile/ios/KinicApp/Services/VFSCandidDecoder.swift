// Where: mobile/ios/KinicApp/Services/VFSCandidDecoder.swift
// What: Minimal Candid decoder for Kinic VFS replies.
// Why: The app only needs Result variants for database listing and source capture writes.

import Foundation

enum VFSCandidDecoder {
    private static let magic = Data([0x44, 0x49, 0x44, 0x4c])
    private static let typeNull: Int64 = -1
    private static let typeBool: Int64 = -2
    private static let typeNat: Int64 = -3
    private static let typeNat32: Int64 = -7
    private static let typeNat64: Int64 = -8
    private static let typeInt64: Int64 = -12
    private static let typeFloat32: Int64 = -13
    private static let typeText: Int64 = -15
    private static let typeOpt: Int64 = -18
    private static let typeVec: Int64 = -19
    private static let typeRecord: Int64 = -20
    private static let typeVariant: Int64 = -21

    static func decodeUnitResult(_ data: Data) throws {
        let ok = try decodeResult(data)
        switch ok {
        case .null, .record:
            return
        default:
            throw VFSCandidError.invalidPayload("expected unit result")
        }
    }

    static func decodeWriteNodeResult(_ data: Data) throws {
        let ok = try decodeResult(data)
        guard case .record = ok else {
            throw VFSCandidError.invalidPayload("expected write_node result")
        }
    }

    static func decodeWriteNodesResult(_ data: Data) throws {
        let ok = try decodeResult(data)
        guard case .vector(let values) = ok else {
            throw VFSCandidError.invalidPayload("expected write_nodes result")
        }
        for value in values {
            guard case .record = value else {
                throw VFSCandidError.invalidPayload("expected write_nodes item result")
            }
        }
    }

    static func decodeMkdirNodeResult(_ data: Data) throws {
        let ok = try decodeResult(data)
        guard case .record = ok else {
            throw VFSCandidError.invalidPayload("expected mkdir_node result")
        }
    }

    static func decodeReadNodeResult(_ data: Data) throws -> VFSNode? {
        let ok = try decodeResult(data)
        guard case .opt(let value) = ok else {
            throw VFSCandidError.invalidPayload("expected read_node optional result")
        }
        guard let value else {
            return nil
        }
        guard case .record(let fields) = value else {
            throw VFSCandidError.invalidPayload("read_node node is not a record")
        }
        return VFSNode(
            path: try text(fields, "path"),
            kind: try nodeKind(from: variant(fields, "kind")),
            content: try text(fields, "content"),
            metadataJson: try text(fields, "metadata_json"),
            etag: try text(fields, "etag"),
            createdAt: try int64(fields, "created_at"),
            updatedAt: try int64(fields, "updated_at")
        )
    }

    static func decodeNodePublicationResult(_ data: Data) throws -> NodePublication {
        try nodePublication(from: decodeResult(data))
    }

    static func decodeOptionalNodePublicationResult(_ data: Data) throws -> NodePublication? {
        let ok = try decodeResult(data)
        guard case .opt(let value) = ok else {
            throw VFSCandidError.invalidPayload("expected optional node publication")
        }
        guard let value else {
            return nil
        }
        return try nodePublication(from: value)
    }

    static func decodeDeleteNodeResult(_ data: Data) throws -> String {
        let ok = try decodeResult(data)
        guard case .record(let fields) = ok else {
            throw VFSCandidError.invalidPayload("expected delete_node result")
        }
        return try text(fields, "path")
    }

    static func decodeChildNodesResult(_ data: Data) throws -> [ChildNode] {
        let ok = try decodeResult(data)
        guard case .vector(let values) = ok else {
            throw VFSCandidError.invalidPayload("expected child node vector")
        }
        return try values.map { value in
            try childNode(from: value)
        }
    }

    static func decodeSearchNodeHitsResult(_ data: Data) throws -> [SearchNodeHit] {
        let ok = try decodeResult(data)
        guard case .vector(let values) = ok else {
            throw VFSCandidError.invalidPayload("expected search hit vector")
        }
        return try values.map { value in
            try searchNodeHit(from: value)
        }
    }

    static func decodeSQLJSONQueryRowsResult(_ data: Data) throws -> [String] {
        let ok = try decodeResult(data)
        guard case .record(let fields) = ok else {
            throw VFSCandidError.invalidPayload("SQL JSON query result is not a record")
        }
        return try textVector(fields, "rows")
    }

    static func decodeDatabaseSummaries(_ data: Data) throws -> [DatabaseSummary] {
        let ok = try decodeResult(data)
        guard case .vector(let values) = ok else {
            throw VFSCandidError.invalidPayload("expected database summary vector")
        }
        return try values.map { value in
            try databaseSummary(from: value)
        }
    }

    static func decodeCyclesBillingConfigResult(_ data: Data) throws -> CyclesBillingConfig {
        let ok = try decodeResult(data)
        guard case .record(let fields) = ok else {
            throw VFSCandidError.invalidPayload("cycles billing config is not a record")
        }
        guard case .record(let topUpFields) = try record(fields, "top_up") else {
            throw VFSCandidError.invalidPayload("top_up is not a record")
        }
        return CyclesBillingConfig(
            kinicLedgerCanisterId: try text(fields, "kinic_ledger_canister_id"),
            billingAuthorityId: try text(fields, "billing_authority_id"),
            cyclesPerKinic: try nat64(fields, "cycles_per_kinic"),
            minUpdateCycles: try nat64(fields, "min_update_cycles"),
            topUp: CyclesTopUpConfig(
                enabled: try bool(topUpFields, "enabled"),
                launcherPrincipal: try text(topUpFields, "launcher_principal"),
                thresholdCycles: try nat(topUpFields, "threshold_cycles")
            )
        )
    }

    static func decodeDatabaseMetadataResult(_ data: Data) throws -> DatabaseMetadata {
        let ok = try decodeResult(data)
        guard case .record(let fields) = ok else {
            throw VFSCandidError.invalidPayload("database metadata is not a record")
        }
        return try databaseMetadata(from: fields)
    }

    static func decodeCreateDatabaseResult(_ data: Data) throws -> CreatedDatabase {
        let ok = try decodeResult(data)
        guard case .record(let fields) = ok else {
            throw VFSCandidError.invalidPayload("expected create_database result")
        }
        return CreatedDatabase(
            databaseId: try text(fields, "database_id"),
            name: try text(fields, "name"),
            status: try databaseStatus(from: variant(fields, "status")),
            initialFreeGrantApplied: try bool(fields, "initial_free_grant_applied")
        )
    }

    static func decodeDatabaseMembersResult(_ data: Data) throws -> [DatabaseMember] {
        let ok = try decodeResult(data)
        guard case .vector(let values) = ok else {
            throw VFSCandidError.invalidPayload("expected database member vector")
        }
        return try values.map { value in
            guard case .record(let fields) = value else {
                throw VFSCandidError.invalidPayload("database member is not a record")
            }
            return DatabaseMember(
                principal: try text(fields, "principal"),
                role: try databaseRole(from: variant(fields, "role")),
                createdAtMs: try int64(fields, "created_at_ms")
            )
        }
    }

    static func decodeDatabaseCycleEntryPageResult(_ data: Data) throws -> DatabaseCycleEntryPage {
        let ok = try decodeResult(data)
        guard case .record(let fields) = ok else {
            throw VFSCandidError.invalidPayload("cycle entry page is not a record")
        }
        guard case .vector(let values) = try record(fields, "entries") else {
            throw VFSCandidError.invalidPayload("expected cycle entry vector")
        }
        return DatabaseCycleEntryPage(
            entries: try values.map(databaseCycleEntry(from:)),
            nextCursor: try optionalNat64(fields, "next_cursor")
        )
    }

    static func decodeDatabaseCyclesPendingPurchasesResult(_ data: Data) throws -> [DatabaseCyclesPendingPurchase] {
        let ok = try decodeResult(data)
        guard case .vector(let values) = ok else {
            throw VFSCandidError.invalidPayload("expected pending purchase vector")
        }
        return try values.map { value in
            guard case .record(let fields) = value else {
                throw VFSCandidError.invalidPayload("pending purchase is not a record")
            }
            return DatabaseCyclesPendingPurchase(
                operationId: try nat64(fields, "operation_id"),
                databaseId: try text(fields, "database_id"),
                status: try text(fields, "status"),
                amountCycles: try nat64(fields, "amount_cycles"),
                paymentAmountE8s: try nat64(fields, "payment_amount_e8s"),
                ledgerBlockIndex: try optionalNat64(fields, "ledger_block_index"),
                createdAtMs: try int64(fields, "created_at_ms"),
                requiredAction: try text(fields, "required_action")
            )
        }
    }

    static func decodeMarketEntitlementPageResult(_ data: Data) throws -> MarketEntitlementPage {
        let ok = try decodeResult(data)
        guard case .record(let fields) = ok else {
            throw VFSCandidError.invalidPayload("market entitlement page is not a record")
        }
        guard case .vector(let values) = try record(fields, "entitlements") else {
            throw VFSCandidError.invalidPayload("expected market entitlement vector")
        }
        return MarketEntitlementPage(
            entitlements: try values.map(marketEntitlement(from:)),
            nextCursor: try optionalText(fields, "next_cursor")
        )
    }

    private static func decodeResult(_ data: Data) throws -> Value {
        var parser = Parser(data: data)
        let values = try parser.parse()
        guard values.count == 1,
              case .variant(let variantLabel, let value) = values[0] else {
            throw VFSCandidError.invalidPayload("expected result variant")
        }
        if variantLabel == label("Err") {
            guard case .text(let message) = value else {
                throw VFSCandidError.invalidPayload("expected Err text")
            }
            throw VFSCandidError.canisterRejected(message)
        }
        guard variantLabel == label("Ok") else {
            throw VFSCandidError.invalidPayload("unknown result variant")
        }
        return value
    }

    private static func databaseSummary(from value: Value) throws -> DatabaseSummary {
        guard case .record(let fields) = value else {
            throw VFSCandidError.invalidPayload("database summary is not a record")
        }
        let topLevelName = try text(fields, "name")
        var metadata: DatabaseMetadata?
        var title = topLevelName
        var description = ""
        guard let metadataValue = fields[label("metadata")] else {
            throw VFSCandidError.invalidPayload("missing metadata field")
        }
        switch metadataValue {
        case .opt(let child):
            guard let child else {
                break
            }
            guard case .record(let metadataFields) = child else {
                throw VFSCandidError.invalidPayload("metadata is not a record")
            }
            let decodedMetadata = try databaseMetadata(from: metadataFields)
            metadata = decodedMetadata
            title = decodedMetadata.name
            description = decodedMetadata.description
        default:
            throw VFSCandidError.invalidPayload("metadata is not optional")
        }
        return DatabaseSummary(
            databaseId: try text(fields, "database_id"),
            title: title,
            description: description,
            metadata: metadata,
            role: try databaseRole(from: variant(fields, "role")),
            status: try databaseStatus(from: variant(fields, "status")),
            logicalSizeBytes: try nat64(fields, "logical_size_bytes"),
            cyclesBalance: try optionalNat64(fields, "cycles_balance"),
            cyclesSuspendedAtMs: try optionalInt64(fields, "cycles_suspended_at_ms"),
            deletedAtMs: try optionalInt64(fields, "deleted_at_ms")
        )
    }

    private static func databaseMetadata(from fields: [UInt32: Value]) throws -> DatabaseMetadata {
        DatabaseMetadata(
            name: try text(fields, "name"),
            description: try text(fields, "description"),
            llmSummary: try optionalText(fields, "llm_summary"),
            tagsJson: try text(fields, "tags_json")
        )
    }

    private static func childNode(from value: Value) throws -> ChildNode {
        guard case .record(let fields) = value else {
            throw VFSCandidError.invalidPayload("child node is not a record")
        }
        return ChildNode(
            path: try text(fields, "path"),
            name: try text(fields, "name"),
            kind: try nodeEntryKind(from: variant(fields, "kind")),
            updatedAt: try optionalInt64(fields, "updated_at"),
            etag: try optionalText(fields, "etag"),
            sizeBytes: try optionalNat64(fields, "size_bytes"),
            hasChildren: try bool(fields, "has_children"),
            isVirtual: try bool(fields, "is_virtual")
        )
    }

    private static func nodePublication(from value: Value) throws -> NodePublication {
        guard case .record(let fields) = value else {
            throw VFSCandidError.invalidPayload("node publication is not a record")
        }
        return NodePublication(
            publicId: try text(fields, "public_id"),
            databaseId: try text(fields, "database_id"),
            path: try text(fields, "path"),
            publishedAtMs: try int64(fields, "published_at_ms")
        )
    }

    private static func searchNodeHit(from value: Value) throws -> SearchNodeHit {
        guard case .record(let fields) = value else {
            throw VFSCandidError.invalidPayload("search hit is not a record")
        }
        return SearchNodeHit(
            path: try text(fields, "path"),
            kind: try nodeKind(from: variant(fields, "kind")),
            snippet: try optionalText(fields, "snippet"),
            previewExcerpt: try previewExcerpt(fields, "preview"),
            matchReasons: try textVector(fields, "match_reasons"),
            score: try float32(fields, "score")
        )
    }

    private static func databaseCycleEntry(from value: Value) throws -> DatabaseCycleEntry {
        guard case .record(let fields) = value else {
            throw VFSCandidError.invalidPayload("cycle entry is not a record")
        }
        return DatabaseCycleEntry(
            entryId: try nat64(fields, "entry_id"),
            databaseId: try text(fields, "database_id"),
            kind: try text(fields, "kind"),
            amountCycles: try int64(fields, "amount_cycles"),
            balanceAfterCycles: try nat64(fields, "balance_after_cycles"),
            caller: try text(fields, "caller"),
            method: try optionalText(fields, "method"),
            ledgerBlockIndex: try optionalNat64(fields, "ledger_block_index"),
            paymentAmountE8s: try optionalNat64(fields, "payment_amount_e8s"),
            cyclesPerKinic: try optionalNat64(fields, "cycles_per_kinic"),
            cyclesDelta: try optionalNat64(fields, "cycles_delta"),
            createdAtMs: try int64(fields, "created_at_ms")
        )
    }

    private static func marketEntitlement(from value: Value) throws -> MarketEntitlement {
        guard case .record(let fields) = value else {
            throw VFSCandidError.invalidPayload("market entitlement is not a record")
        }
        return MarketEntitlement(
            databaseId: try text(fields, "database_id"),
            buyerPrincipal: try text(fields, "buyer_principal"),
            listingId: try text(fields, "listing_id"),
            orderId: try text(fields, "order_id"),
            purchasedAtMs: try int64(fields, "purchased_at_ms"),
            status: try text(fields, "status")
        )
    }

    private static func databaseRole(from variantLabel: UInt32) throws -> DatabaseRole {
        if variantLabel == label("Owner") {
            return .owner
        }
        if variantLabel == label("Writer") {
            return .writer
        }
        if variantLabel == label("Reader") {
            return .reader
        }
        throw VFSCandidError.invalidPayload("unknown database role")
    }

    private static func databaseStatus(from variantLabel: UInt32) throws -> DatabaseStatus {
        if variantLabel == label("Active") {
            return .active
        }
        if variantLabel == label("Deleted") {
            return .deleted
        }
        if variantLabel == label("Pending") {
            return .pending
        }
        throw VFSCandidError.invalidPayload("unknown database status")
    }

    private static func nodeKind(from variantLabel: UInt32) throws -> VFSNodeKind {
        if variantLabel == label("File") {
            return .file
        }
        if variantLabel == label("Folder") {
            return .folder
        }
        if variantLabel == label("Source") {
            return .source
        }
        throw VFSCandidError.invalidPayload("unknown node kind")
    }

    private static func nodeEntryKind(from variantLabel: UInt32) throws -> VFSNodeKind {
        if variantLabel == label("Directory") {
            return .folder
        }
        return try nodeKind(from: variantLabel)
    }

    private static func text(_ fields: [UInt32: Value], _ name: String) throws -> String {
        guard let value = fields[label(name)],
              case .text(let text) = value else {
            throw VFSCandidError.invalidPayload("missing text field \(name)")
        }
        return text
    }

    private static func bool(_ fields: [UInt32: Value], _ name: String) throws -> Bool {
        guard let value = fields[label(name)],
              case .bool(let bool) = value else {
            throw VFSCandidError.invalidPayload("missing bool field \(name)")
        }
        return bool
    }

    private static func record(_ fields: [UInt32: Value], _ name: String) throws -> Value {
        guard let value = fields[label(name)] else {
            throw VFSCandidError.invalidPayload("missing record field \(name)")
        }
        return value
    }

    private static func int64(_ fields: [UInt32: Value], _ name: String) throws -> Int64 {
        guard let value = fields[label(name)],
              case .int64(let int64) = value else {
            throw VFSCandidError.invalidPayload("missing int64 field \(name)")
        }
        return int64
    }

    private static func nat(_ fields: [UInt32: Value], _ name: String) throws -> UInt64 {
        guard let value = fields[label(name)],
              case .nat(let nat) = value else {
            throw VFSCandidError.invalidPayload("missing nat field \(name)")
        }
        return nat
    }

    private static func nat64(_ fields: [UInt32: Value], _ name: String) throws -> UInt64 {
        guard let value = fields[label(name)],
              case .nat64(let nat64) = value else {
            throw VFSCandidError.invalidPayload("missing nat64 field \(name)")
        }
        return nat64
    }

    private static func float32(_ fields: [UInt32: Value], _ name: String) throws -> Float {
        guard let value = fields[label(name)],
              case .float32(let float32) = value else {
            throw VFSCandidError.invalidPayload("missing float32 field \(name)")
        }
        return float32
    }

    private static func optionalText(_ fields: [UInt32: Value], _ name: String) throws -> String? {
        guard let value = fields[label(name)],
              case .opt(let child) = value else {
            throw VFSCandidError.invalidPayload("missing optional text field \(name)")
        }
        guard let child else {
            return nil
        }
        guard case .text(let text) = child else {
            throw VFSCandidError.invalidPayload("optional field \(name) is not text")
        }
        return text
    }

    private static func optionalInt64(_ fields: [UInt32: Value], _ name: String) throws -> Int64? {
        guard let value = fields[label(name)],
              case .opt(let child) = value else {
            throw VFSCandidError.invalidPayload("missing optional int64 field \(name)")
        }
        guard let child else {
            return nil
        }
        guard case .int64(let int64) = child else {
            throw VFSCandidError.invalidPayload("optional field \(name) is not int64")
        }
        return int64
    }

    private static func optionalNat64(_ fields: [UInt32: Value], _ name: String) throws -> UInt64? {
        guard let value = fields[label(name)],
              case .opt(let child) = value else {
            throw VFSCandidError.invalidPayload("missing optional nat64 field \(name)")
        }
        guard let child else {
            return nil
        }
        guard case .nat64(let nat64) = child else {
            throw VFSCandidError.invalidPayload("optional field \(name) is not nat64")
        }
        return nat64
    }

    private static func textVector(_ fields: [UInt32: Value], _ name: String) throws -> [String] {
        guard let value = fields[label(name)],
              case .vector(let values) = value else {
            throw VFSCandidError.invalidPayload("missing text vector field \(name)")
        }
        return try values.map { value in
            guard case .text(let text) = value else {
                throw VFSCandidError.invalidPayload("vector field \(name) contains non-text")
            }
            return text
        }
    }

    private static func previewExcerpt(_ fields: [UInt32: Value], _ name: String) throws -> String? {
        guard let value = fields[label(name)],
              case .opt(let child) = value else {
            throw VFSCandidError.invalidPayload("missing optional preview field \(name)")
        }
        guard let child else {
            return nil
        }
        guard case .record(let previewFields) = child else {
            throw VFSCandidError.invalidPayload("preview field is not a record")
        }
        return try optionalText(previewFields, "excerpt")
    }

    private static func variant(_ fields: [UInt32: Value], _ name: String) throws -> UInt32 {
        guard let value = fields[label(name)],
              case .variant(let label, _) = value else {
            throw VFSCandidError.invalidPayload("missing variant field \(name)")
        }
        return label
    }

    private static func label(_ name: String) -> UInt32 {
        VFSCandidLabels.id(name)
    }

    private struct Parser {
        let data: Data
        var offset = 0
        var table: [TypeEntry] = []

        init(data: Data) {
            self.data = data
        }

        mutating func parse() throws -> [Value] {
            guard data.count >= 4,
                  data.prefix(4) == magic else {
                throw VFSCandidError.invalidPayload("missing DIDL header")
            }
            offset = 4
            let tableCount = try readUnsigned()
            table = []
            for _ in 0..<tableCount {
                table.append(try readTypeEntry())
            }
            let argCount = try readUnsigned()
            var argTypes: [TypeRef] = []
            for _ in 0..<argCount {
                argTypes.append(try readTypeRef())
            }
            var values: [Value] = []
            for type in argTypes {
                values.append(try readValue(type))
            }
            guard offset == data.count else {
                throw VFSCandidError.invalidPayload("trailing bytes")
            }
            return values
        }

        private mutating func readTypeEntry() throws -> TypeEntry {
            let code = try readSigned()
            switch code {
            case typeOpt:
                return .opt(try readTypeRef())
            case typeVec:
                return .vec(try readTypeRef())
            case typeRecord:
                return .record(try readFields())
            case typeVariant:
                return .variant(try readFields())
            default:
                throw VFSCandidError.invalidPayload("unsupported type table entry \(code)")
            }
        }

        private mutating func readFields() throws -> [Field] {
            let count = try readUnsigned()
            var fields: [Field] = []
            for _ in 0..<count {
                let id = UInt32(try readUnsigned())
                fields.append(Field(id: id, type: try readTypeRef()))
            }
            return fields
        }

        private mutating func readTypeRef() throws -> TypeRef {
            let value = try readSigned()
            if value < 0 {
                return .primitive(value)
            }
            guard value <= Int64(Int.max) else {
                throw VFSCandidError.invalidPayload("type reference too large")
            }
            return .table(Int(value))
        }

        private mutating func readValue(_ type: TypeRef) throws -> Value {
            switch type {
            case .primitive(let code):
                return try readPrimitive(code)
            case .table(let index):
                guard table.indices.contains(index) else {
                    throw VFSCandidError.invalidPayload("type reference is out of bounds")
                }
                switch table[index] {
                case .opt(let child):
                    let tag = try readByte()
                    if tag == 0 {
                        return .opt(nil)
                    }
                    if tag != 1 {
                        throw VFSCandidError.invalidPayload("invalid opt tag")
                    }
                    return .opt(try readValue(child))
                case .vec(let child):
                    let count = try readUnsigned()
                    var values: [Value] = []
                    for _ in 0..<count {
                        values.append(try readValue(child))
                    }
                    return .vector(values)
                case .record(let fields):
                    var values: [UInt32: Value] = [:]
                    for field in fields {
                        values[field.id] = try readValue(field.type)
                    }
                    return .record(values)
                case .variant(let fields):
                    let index = Int(try readUnsigned())
                    guard fields.indices.contains(index) else {
                        throw VFSCandidError.invalidPayload("variant index is out of bounds")
                    }
                    let field = fields[index]
                    return .variant(field.id, try readValue(field.type))
                }
            }
        }

        private mutating func readPrimitive(_ code: Int64) throws -> Value {
            switch code {
            case typeNull:
                return .null
            case typeBool:
                let byte = try readByte()
                if byte == 0 {
                    return .bool(false)
                }
                if byte == 1 {
                    return .bool(true)
                }
                throw VFSCandidError.invalidPayload("invalid bool")
            case typeNat:
                return .nat(try readUnsigned())
            case typeNat32:
                return .nat32(try readFixedUInt32())
            case typeNat64:
                return .nat64(try readFixedUInt64())
            case typeInt64:
                return .int64(try readFixedInt64())
            case typeFloat32:
                return .float32(try readFixedFloat32())
            case typeText:
                let count = Int(try readUnsigned())
                guard offset + count <= data.count else {
                    throw VFSCandidError.invalidPayload("text exceeds payload")
                }
                let bytes = data[offset..<(offset + count)]
                offset += count
                guard let text = String(data: bytes, encoding: .utf8) else {
                    throw VFSCandidError.invalidPayload("text is not utf8")
                }
                return .text(text)
            default:
                throw VFSCandidError.invalidPayload("unsupported primitive \(code)")
            }
        }

        private mutating func readFixedUInt64() throws -> UInt64 {
            guard offset + 8 <= data.count else {
                throw VFSCandidError.invalidPayload("nat64 exceeds payload")
            }
            let bytes = data[offset..<(offset + 8)]
            offset += 8
            return bytes.enumerated().reduce(UInt64(0)) { partial, item in
                partial | (UInt64(item.element) << UInt64(item.offset * 8))
            }
        }

        private mutating func readFixedUInt32() throws -> UInt32 {
            guard offset + 4 <= data.count else {
                throw VFSCandidError.invalidPayload("nat32 exceeds payload")
            }
            let bytes = data[offset..<(offset + 4)]
            offset += 4
            return bytes.enumerated().reduce(UInt32(0)) { partial, item in
                partial | (UInt32(item.element) << UInt32(item.offset * 8))
            }
        }

        private mutating func readFixedInt64() throws -> Int64 {
            let unsigned = try readFixedUInt64()
            return Int64(bitPattern: unsigned)
        }

        private mutating func readFixedFloat32() throws -> Float {
            guard offset + 4 <= data.count else {
                throw VFSCandidError.invalidPayload("float32 exceeds payload")
            }
            let bytes = data[offset..<(offset + 4)]
            offset += 4
            let bitPattern = bytes.enumerated().reduce(UInt32(0)) { partial, item in
                partial | (UInt32(item.element) << UInt32(item.offset * 8))
            }
            return Float(bitPattern: bitPattern)
        }

        private mutating func readByte() throws -> UInt8 {
            guard offset < data.count else {
                throw VFSCandidError.invalidPayload("unexpected end of payload")
            }
            let byte = data[offset]
            offset += 1
            return byte
        }

        private mutating func readUnsigned() throws -> UInt64 {
            try VFSCandidLEB.readUnsigned(from: data, offset: &offset)
        }

        private mutating func readSigned() throws -> Int64 {
            try VFSCandidLEB.readSigned(from: data, offset: &offset)
        }
    }

    private struct Field {
        let id: UInt32
        let type: TypeRef
    }

    private enum TypeRef {
        case primitive(Int64)
        case table(Int)
    }

    private enum TypeEntry {
        case opt(TypeRef)
        case vec(TypeRef)
        case record([Field])
        case variant([Field])
    }

    private indirect enum Value {
        case null
        case bool(Bool)
        case text(String)
        case nat(UInt64)
        case nat32(UInt32)
        case nat64(UInt64)
        case int64(Int64)
        case float32(Float)
        case opt(Value?)
        case vector([Value])
        case record([UInt32: Value])
        case variant(UInt32, Value)
    }
}

enum VFSNodeKind: Equatable, Sendable {
    case folder
    case file
    case source
}

struct VFSNode: Identifiable, Equatable, Sendable {
    let path: String
    let kind: VFSNodeKind
    let content: String
    let metadataJson: String
    let etag: String
    let createdAt: Int64
    let updatedAt: Int64

    var id: String {
        path
    }
}
