// Where: mobile/ios/KinicApp/Services/VFSCandidTypes.swift
// What: Typed Candid models matching crates/vfs_canister/vfs.did.
// Why: VFS traffic must use ICNativeClient's verified typed transport without an app-owned codec.

import Foundation
import ICNativeClient

private func fields(_ entries: [(String, CandidType)]) -> [CandidField] {
    entries.map { CandidField($0.0, type: $0.1) }
}

private func recordValue(_ type: CandidType, _ entries: [(String, CandidValue)]) -> CandidValue {
    guard case .record(let recordFields) = type else { preconditionFailure("record type required") }
    return .record(recordFields, Dictionary(uniqueKeysWithValues: entries.map { (Candid.fieldID($0.0), $0.1) }))
}

private func variantValue(_ type: CandidType, tag: String, value: CandidValue = .null) -> CandidValue {
    guard case .variant(let variantFields) = type else { preconditionFailure("variant type required") }
    return .variant(try! CandidVariant(fields: variantFields, tag: tag, value: value))
}

private func variantTag(_ value: CandidValue, type: CandidType) throws -> (String, CandidValue) {
    guard case .variant(let variant) = value, case .variant(let declared) = type else {
        throw ICClientError.invalidCandid("expected variant")
    }
    for name in ["Ok", "Err", "Owner", "Writer", "Reader", "Active", "Deleted", "Pending", "Folder", "File", "Source", "Directory", "Light", "ContentStart", "None", "EtagConflict", "NotFound", "Forbidden", "WriteUnavailable", "InvalidOperation", "Path", "Content"] where Candid.fieldID(name) == variant.tag && declared.contains(where: { $0.id == variant.tag }) {
        return (name, variant.value)
    }
    throw ICClientError.invalidCandid("unknown variant tag \(variant.tag)")
}

enum VFSCandidResult<Success: CandidConvertible, Failure: CandidConvertible>: CandidConvertible {
    case ok(Success)
    case err(Failure)

    static var candidType: CandidType {
        .variant(fields([("Ok", Success.candidType), ("Err", Failure.candidType)]))
    }

    init(candidValue: CandidValue) throws {
        let (tag, payload) = try variantTag(candidValue, type: Self.candidType)
        switch tag {
        case "Ok": self = .ok(try Success(candidValue: payload))
        case "Err": self = .err(try Failure(candidValue: payload))
        default: throw ICClientError.invalidCandid("expected VFS Result")
        }
    }

    var candidValue: CandidValue {
        switch self {
        case .ok(let value): variantValue(Self.candidType, tag: "Ok", value: value.candidValue)
        case .err(let value): variantValue(Self.candidType, tag: "Err", value: value.candidValue)
        }
    }

    func textValue() throws -> Success where Failure == String {
        switch self {
        case .ok(let value): value
        case .err(let message): throw VFSCandidError.canisterRejected(message)
        }
    }

    func mutationValue() throws -> Success where Failure == VFSNodeMutationFailure {
        switch self {
        case .ok(let value): value
        case .err(let failure): throw VFSCandidError.nodeMutationRejected(failure)
        }
    }
}

struct VFSDatabaseIDRequest: CandidConvertible {
    let databaseId: String
    static let candidType: CandidType = .record(fields([("database_id", .text)]))
    init(databaseId: String) { self.databaseId = databaseId }
    init(candidValue: CandidValue) throws { databaseId = try CandidRecord(candidValue).required("database_id") }
    var candidValue: CandidValue { recordValue(Self.candidType, [("database_id", databaseId.candidValue)]) }
}

struct VFSPathRequest: CandidConvertible {
    let databaseId: String
    let path: String
    static let candidType: CandidType = .record(fields([("path", .text), ("database_id", .text)]))
    init(databaseId: String, path: String) { self.databaseId = databaseId; self.path = path }
    init(candidValue: CandidValue) throws { let r = try CandidRecord(candidValue); path = try r.required("path"); databaseId = try r.required("database_id") }
    var candidValue: CandidValue { recordValue(Self.candidType, [("path", path.candidValue), ("database_id", databaseId.candidValue)]) }
}

struct VFSDeleteNodeRequest: CandidConvertible {
    let databaseId: String; let path: String; let expectedEtag: String?; let expectedFolderIndexEtag: String?
    static let candidType: CandidType = .record(fields([("path", .text), ("expected_etag", Optional<String>.candidType), ("database_id", .text), ("expected_folder_index_etag", Optional<String>.candidType)]))
    init(databaseId: String, path: String, expectedEtag: String?, expectedFolderIndexEtag: String? = nil) { self.databaseId = databaseId; self.path = path; self.expectedEtag = expectedEtag; self.expectedFolderIndexEtag = expectedFolderIndexEtag }
    init(candidValue: CandidValue) throws { let r = try CandidRecord(candidValue); path = try r.required("path"); expectedEtag = try r.required("expected_etag"); databaseId = try r.required("database_id"); expectedFolderIndexEtag = try r.required("expected_folder_index_etag") }
    var candidValue: CandidValue { recordValue(Self.candidType, [("path", path.candidValue), ("expected_etag", expectedEtag.candidValue), ("database_id", databaseId.candidValue), ("expected_folder_index_etag", expectedFolderIndexEtag.candidValue)]) }
}

enum VFSSearchPreviewMode: CandidConvertible {
    case light, contentStart, none
    static let candidType: CandidType = .variant(fields([("Light", .null), ("ContentStart", .null), ("None", .null)]))
    init(candidValue: CandidValue) throws {
        switch try variantTag(candidValue, type: Self.candidType).0 { case "Light": self = .light; case "ContentStart": self = .contentStart; case "None": self = .none; default: throw ICClientError.invalidCandid("invalid preview mode") }
    }
    var candidValue: CandidValue { variantValue(Self.candidType, tag: self == .light ? "Light" : self == .contentStart ? "ContentStart" : "None") }
}

struct VFSSearchNodesRequest: CandidConvertible {
    let databaseId: String; let queryText: String; let prefix: String?; let topK: UInt32; let previewMode: VFSSearchPreviewMode?
    static let candidType: CandidType = .record(fields([("top_k", .nat32), ("database_id", .text), ("preview_mode", Optional<VFSSearchPreviewMode>.candidType), ("prefix", Optional<String>.candidType), ("query_text", .text)]))
    init(databaseId: String, queryText: String, prefix: String?, topK: UInt32, previewMode: VFSSearchPreviewMode? = .light) { self.databaseId = databaseId; self.queryText = queryText; self.prefix = prefix; self.topK = topK; self.previewMode = previewMode }
    init(candidValue: CandidValue) throws { let r = try CandidRecord(candidValue); topK = try r.required("top_k"); databaseId = try r.required("database_id"); previewMode = try r.required("preview_mode"); queryText = try r.required("query_text"); prefix = try r.required("prefix") }
    var candidValue: CandidValue { recordValue(Self.candidType, [("top_k", topK.candidValue), ("database_id", databaseId.candidValue), ("preview_mode", previewMode.candidValue), ("prefix", prefix.candidValue), ("query_text", queryText.candidValue)]) }
}

struct VFSCreateDatabaseRequest: CandidConvertible {
    let name: String
    static let candidType: CandidType = .record(fields([("name", .text)]))
    init(name: String) { self.name = name }
    init(candidValue: CandidValue) throws { name = try CandidRecord(candidValue).required("name") }
    var candidValue: CandidValue { recordValue(Self.candidType, [("name", name.candidValue)]) }
}

struct VFSUpdateDatabaseMetadataRequest: CandidConvertible {
    let databaseId: String; let name: String; let description: String; let llmSummary: String?; let tagsJson: String
    static let candidType: CandidType = .record(fields([("llm_summary", Optional<String>.candidType), ("name", .text), ("description", .text), ("database_id", .text), ("tags_json", .text)]))
    init(databaseId: String, name: String, description: String, llmSummary: String?, tagsJson: String) { self.databaseId = databaseId; self.name = name; self.description = description; self.llmSummary = llmSummary; self.tagsJson = tagsJson }
    init(candidValue: CandidValue) throws { let r = try CandidRecord(candidValue); llmSummary = try r.required("llm_summary"); name = try r.required("name"); description = try r.required("description"); databaseId = try r.required("database_id"); tagsJson = try r.required("tags_json") }
    var candidValue: CandidValue { recordValue(Self.candidType, [("llm_summary", llmSummary.candidValue), ("name", name.candidValue), ("description", description.candidValue), ("database_id", databaseId.candidValue), ("tags_json", tagsJson.candidValue)]) }
}

struct VFSSourceCaptureTriggerSessionRequest: CandidConvertible {
    let databaseId: String; let sessionNonce: String
    static let candidType: CandidType = .record(fields([("session_nonce", .text), ("database_id", .text)]))
    init(databaseId: String, sessionNonce: String) { self.databaseId = databaseId; self.sessionNonce = sessionNonce }
    init(candidValue: CandidValue) throws { let r = try CandidRecord(candidValue); sessionNonce = try r.required("session_nonce"); databaseId = try r.required("database_id") }
    var candidValue: CandidValue { recordValue(Self.candidType, [("session_nonce", sessionNonce.candidValue), ("database_id", databaseId.candidValue)]) }
}

struct VFSWriteNodeItem: CandidConvertible {
    let content: String; let kind: VFSNodeKind; let path: String; let expectedEtag: String?; let metadataJson: String
    static let candidType: CandidType = .record(fields([("content", .text), ("kind", VFSNodeKind.candidType), ("path", .text), ("expected_etag", Optional<String>.candidType), ("metadata_json", .text)]))
    init(content: String, kind: VFSNodeKind, path: String, expectedEtag: String?, metadataJson: String) { self.content = content; self.kind = kind; self.path = path; self.expectedEtag = expectedEtag; self.metadataJson = metadataJson }
    init(candidValue: CandidValue) throws { let r = try CandidRecord(candidValue); content = try r.required("content"); kind = try r.required("kind"); path = try r.required("path"); expectedEtag = try r.required("expected_etag"); metadataJson = try r.required("metadata_json") }
    var candidValue: CandidValue { recordValue(Self.candidType, [("content", content.candidValue), ("kind", kind.candidValue), ("path", path.candidValue), ("expected_etag", expectedEtag.candidValue), ("metadata_json", metadataJson.candidValue)]) }
}

struct VFSWriteNodeRequest: CandidConvertible {
    let databaseId: String; let item: VFSWriteNodeItem
    static let candidType: CandidType = .record(fields([("content", .text), ("kind", VFSNodeKind.candidType), ("path", .text), ("expected_etag", Optional<String>.candidType), ("metadata_json", .text), ("database_id", .text)]))
    init(databaseId: String, path: String, kind: VFSNodeKind, content: String, metadataJson: String, expectedEtag: String?) { self.databaseId = databaseId; item = .init(content: content, kind: kind, path: path, expectedEtag: expectedEtag, metadataJson: metadataJson) }
    init(candidValue: CandidValue) throws { let r = try CandidRecord(candidValue); databaseId = try r.required("database_id"); item = .init(content: try r.required("content"), kind: try r.required("kind"), path: try r.required("path"), expectedEtag: try r.required("expected_etag"), metadataJson: try r.required("metadata_json")) }
    var candidValue: CandidValue { recordValue(Self.candidType, [("content", item.content.candidValue), ("kind", item.kind.candidValue), ("path", item.path.candidValue), ("expected_etag", item.expectedEtag.candidValue), ("metadata_json", item.metadataJson.candidValue), ("database_id", databaseId.candidValue)]) }
}

struct VFSWriteNodesRequest: CandidConvertible {
    let databaseId: String; let nodes: [VFSWriteNodeItem]
    static let candidType: CandidType = .record(fields([("nodes", [VFSWriteNodeItem].candidType), ("database_id", .text)]))
    init(databaseId: String, nodes: [VFSWriteNodeItem]) { self.databaseId = databaseId; self.nodes = nodes }
    init(candidValue: CandidValue) throws { let r = try CandidRecord(candidValue); nodes = try r.required("nodes"); databaseId = try r.required("database_id") }
    var candidValue: CandidValue { recordValue(Self.candidType, [("nodes", nodes.candidValue), ("database_id", databaseId.candidValue)]) }
}

enum VFSNodeKind: Equatable, Sendable, CandidConvertible {
    case folder, file, source
    static let candidType: CandidType = .variant(fields([("Folder", .null), ("File", .null), ("Source", .null)]))
    init(candidValue: CandidValue) throws { switch try variantTag(candidValue, type: Self.candidType).0 { case "Folder", "Directory": self = .folder; case "File": self = .file; case "Source": self = .source; default: throw ICClientError.invalidCandid("invalid node kind") } }
    var candidValue: CandidValue { variantValue(Self.candidType, tag: self == .folder ? "Folder" : self == .file ? "File" : "Source") }
}

private enum VFSNodeEntryKind: CandidConvertible {
    case folder, file, source
    static let candidType: CandidType = .variant(fields([("Folder", .null), ("File", .null), ("Source", .null), ("Directory", .null)]))
    init(candidValue: CandidValue) throws { switch try variantTag(candidValue, type: Self.candidType).0 { case "Folder", "Directory": self = .folder; case "File": self = .file; case "Source": self = .source; default: throw ICClientError.invalidCandid("invalid node entry kind") } }
    var candidValue: CandidValue { variantValue(Self.candidType, tag: self == .folder ? "Folder" : self == .file ? "File" : "Source") }
    var nodeKind: VFSNodeKind { self == .folder ? .folder : self == .file ? .file : .source }
}

extension DatabaseRole: CandidConvertible {
    static let candidType: CandidType = .variant(fields([("Reader", .null), ("Writer", .null), ("Owner", .null)]))
    init(candidValue: CandidValue) throws { switch try variantTag(candidValue, type: Self.candidType).0 { case "Owner": self = .owner; case "Writer": self = .writer; case "Reader": self = .reader; default: throw ICClientError.invalidCandid("invalid database role") } }
    var candidValue: CandidValue { variantValue(Self.candidType, tag: candidName) }
}

extension DatabaseStatus: CandidConvertible {
    static let candidType: CandidType = .variant(fields([("Active", .null), ("Deleted", .null), ("Pending", .null)]))
    init(candidValue: CandidValue) throws { switch try variantTag(candidValue, type: Self.candidType).0 { case "Active": self = .active; case "Deleted": self = .deleted; case "Pending": self = .pending; default: throw ICClientError.invalidCandid("invalid database status") } }
    var candidValue: CandidValue { variantValue(Self.candidType, tag: self == .active ? "Active" : self == .deleted ? "Deleted" : "Pending") }
}

extension DatabaseMetadata: CandidConvertible {
    static let candidType: CandidType = .record(fields([("llm_summary", Optional<String>.candidType), ("name", .text), ("description", .text), ("tags_json", .text)]))
    init(candidValue: CandidValue) throws { let r = try CandidRecord(candidValue); llmSummary = try r.required("llm_summary"); name = try r.required("name"); description = try r.required("description"); tagsJson = try r.required("tags_json") }
    var candidValue: CandidValue { recordValue(Self.candidType, [("llm_summary", llmSummary.candidValue), ("name", name.candidValue), ("description", description.candidValue), ("tags_json", tagsJson.candidValue)]) }
}

extension DatabaseSummary: CandidConvertible {
    static let candidType: CandidType = .record(fields([("status", DatabaseStatus.candidType), ("cycles_balance", Optional<UInt64>.candidType), ("metadata", Optional<DatabaseMetadata>.candidType), ("name", .text), ("role", DatabaseRole.candidType), ("logical_size_bytes", .nat64), ("cycles_suspended_at_ms", Optional<Int64>.candidType), ("database_id", .text), ("deleted_at_ms", Optional<Int64>.candidType)]))
    init(candidValue: CandidValue) throws { let r = try CandidRecord(candidValue); let topName: String = try r.required("name"); metadata = try r.required("metadata"); databaseId = try r.required("database_id"); title = metadata?.name ?? topName; description = metadata?.description ?? ""; role = try r.required("role"); status = try r.required("status"); logicalSizeBytes = try r.required("logical_size_bytes"); cyclesBalance = try r.required("cycles_balance"); cyclesSuspendedAtMs = try r.required("cycles_suspended_at_ms"); deletedAtMs = try r.required("deleted_at_ms") }
    var candidValue: CandidValue { recordValue(Self.candidType, [("status", status.candidValue), ("cycles_balance", cyclesBalance.candidValue), ("metadata", metadata.candidValue), ("name", title.candidValue), ("role", role.candidValue), ("logical_size_bytes", logicalSizeBytes.candidValue), ("cycles_suspended_at_ms", cyclesSuspendedAtMs.candidValue), ("database_id", databaseId.candidValue), ("deleted_at_ms", deletedAtMs.candidValue)]) }
}

extension CyclesTopUpConfig: CandidConvertible {
    static let candidType: CandidType = .record(fields([("enabled", .bool), ("threshold_cycles", .nat), ("launcher_principal", .text)]))
    init(candidValue: CandidValue) throws { let r = try CandidRecord(candidValue); enabled = try r.required("enabled"); launcherPrincipal = try r.required("launcher_principal"); let n: CandidNat = try r.required("threshold_cycles"); guard let v = UInt64(n.decimal) else { throw ICClientError.invalidCandid("threshold_cycles exceeds UInt64") }; thresholdCycles = v }
    var candidValue: CandidValue { let n = try! CandidNat(String(thresholdCycles)); return recordValue(Self.candidType, [("enabled", enabled.candidValue), ("threshold_cycles", n.candidValue), ("launcher_principal", launcherPrincipal.candidValue)]) }
}

extension CyclesBillingConfig: CandidConvertible {
    static let candidType: CandidType = .record(fields([("billing_authority_id", .text), ("iap_authority_id", .text), ("kinic_ledger_canister_id", .text), ("top_up", CyclesTopUpConfig.candidType), ("cycles_per_kinic", .nat64), ("min_update_cycles", .nat64)]))
    init(candidValue: CandidValue) throws { let r = try CandidRecord(candidValue); billingAuthorityId = try r.required("billing_authority_id"); iapAuthorityId = try r.required("iap_authority_id"); kinicLedgerCanisterId = try r.required("kinic_ledger_canister_id"); topUp = try r.required("top_up"); cyclesPerKinic = try r.required("cycles_per_kinic"); minUpdateCycles = try r.required("min_update_cycles") }
    var candidValue: CandidValue { recordValue(Self.candidType, [("billing_authority_id", billingAuthorityId.candidValue), ("iap_authority_id", iapAuthorityId.candidValue), ("kinic_ledger_canister_id", kinicLedgerCanisterId.candidValue), ("top_up", topUp.candidValue), ("cycles_per_kinic", cyclesPerKinic.candidValue), ("min_update_cycles", minUpdateCycles.candidValue)]) }
}

extension VFSNode: CandidConvertible {
    static let candidType: CandidType = .record(fields([("updated_at", .int64), ("content", .text), ("etag", .text), ("kind", VFSNodeKind.candidType), ("path", .text), ("created_at", .int64), ("metadata_json", .text)]))
    init(candidValue: CandidValue) throws { let r = try CandidRecord(candidValue); updatedAt = try r.required("updated_at"); content = try r.required("content"); etag = try r.required("etag"); kind = try r.required("kind"); path = try r.required("path"); createdAt = try r.required("created_at"); metadataJson = try r.required("metadata_json") }
    var candidValue: CandidValue { recordValue(Self.candidType, [("updated_at", updatedAt.candidValue), ("content", content.candidValue), ("etag", etag.candidValue), ("kind", kind.candidValue), ("path", path.candidValue), ("created_at", createdAt.candidValue), ("metadata_json", metadataJson.candidValue)]) }
}

extension VFSNodeMutationAck: CandidConvertible {
    static let candidType: CandidType = .record(fields([("updated_at", .int64), ("etag", .text), ("kind", VFSNodeKind.candidType), ("path", .text)]))
    init(candidValue: CandidValue) throws { let r = try CandidRecord(candidValue); updatedAt = try r.required("updated_at"); etag = try r.required("etag"); kind = try r.required("kind"); path = try r.required("path") }
    var candidValue: CandidValue { recordValue(Self.candidType, [("updated_at", updatedAt.candidValue), ("etag", etag.candidValue), ("kind", kind.candidValue), ("path", path.candidValue)]) }
}

extension VFSWriteNodeResult: CandidConvertible {
    static let candidType: CandidType = .record(fields([("created", .bool), ("node", VFSNodeMutationAck.candidType)]))
    init(candidValue: CandidValue) throws { let r = try CandidRecord(candidValue); created = try r.required("created"); node = try r.required("node") }
    var candidValue: CandidValue { recordValue(Self.candidType, [("created", created.candidValue), ("node", node.candidValue)]) }
}

struct VFSSQLJSONResult: CandidConvertible { let rows: [String]; let rowCount: UInt32; let limit: UInt32; static let candidType: CandidType = .record(fields([("rows", [String].candidType), ("row_count", .nat32), ("limit", .nat32)])); init(candidValue: CandidValue) throws { let r = try CandidRecord(candidValue); rows = try r.required("rows"); rowCount = try r.required("row_count"); limit = try r.required("limit") }; var candidValue: CandidValue { recordValue(Self.candidType, [("rows", rows.candidValue), ("row_count", rowCount.candidValue), ("limit", limit.candidValue)]) } }

extension ChildNode: CandidConvertible {
    static let candidType: CandidType = .record(fields([("updated_at", Optional<Int64>.candidType), ("etag", Optional<String>.candidType), ("kind", VFSNodeEntryKind.candidType), ("name", .text), ("size_bytes", Optional<UInt64>.candidType), ("path", .text), ("is_published", .bool), ("has_children", .bool), ("is_virtual", .bool)]))
    init(candidValue: CandidValue) throws { let r = try CandidRecord(candidValue); updatedAt = try r.required("updated_at"); etag = try r.required("etag"); let entry: VFSNodeEntryKind = try r.required("kind"); kind = entry.nodeKind; name = try r.required("name"); sizeBytes = try r.required("size_bytes"); path = try r.required("path"); let _: Bool = try r.required("is_published"); hasChildren = try r.required("has_children"); isVirtual = try r.required("is_virtual") }
    var candidValue: CandidValue { let entry: VFSNodeEntryKind = kind == .folder ? .folder : kind == .file ? .file : .source; return recordValue(Self.candidType, [("updated_at", updatedAt.candidValue), ("etag", etag.candidValue), ("kind", entry.candidValue), ("name", name.candidValue), ("size_bytes", sizeBytes.candidValue), ("path", path.candidValue), ("is_published", false.candidValue), ("has_children", hasChildren.candidValue), ("is_virtual", isVirtual.candidValue)]) }
}

private struct VFSSearchPreview: CandidConvertible {
    private let field: Field
    private let charOffset: UInt32
    private let matchReason: String
    let excerpt: String?
    private enum Field: CandidConvertible { case path, content; static let candidType: CandidType = .variant(fields([("Path", .null), ("Content", .null)])); init(candidValue: CandidValue) throws { self = try variantTag(candidValue, type: Self.candidType).0 == "Path" ? .path : .content }; var candidValue: CandidValue { variantValue(Self.candidType, tag: self == .path ? "Path" : "Content") } }
    static let candidType: CandidType = .record(fields([("field", Field.candidType), ("char_offset", .nat32), ("match_reason", .text), ("excerpt", Optional<String>.candidType)]))
    init(excerpt: String?) { field = .content; charOffset = 0; matchReason = ""; self.excerpt = excerpt }
    init(candidValue: CandidValue) throws { let r = try CandidRecord(candidValue); field = try r.required("field"); charOffset = try r.required("char_offset"); matchReason = try r.required("match_reason"); excerpt = try r.required("excerpt") }
    var candidValue: CandidValue { recordValue(Self.candidType, [("field", field.candidValue), ("char_offset", charOffset.candidValue), ("match_reason", matchReason.candidValue), ("excerpt", excerpt.candidValue)]) }
}

extension SearchNodeHit: CandidConvertible {
    static let candidType: CandidType = .record(fields([("preview", Optional<VFSSearchPreview>.candidType), ("kind", VFSNodeKind.candidType), ("path", .text), ("match_reasons", [String].candidType), ("snippet", Optional<String>.candidType), ("score", .float32)]))
    init(candidValue: CandidValue) throws { let r = try CandidRecord(candidValue); let preview: VFSSearchPreview? = try r.required("preview"); previewExcerpt = preview?.excerpt; kind = try r.required("kind"); path = try r.required("path"); matchReasons = try r.required("match_reasons"); snippet = try r.required("snippet"); score = try r.required("score") }
    var candidValue: CandidValue { let preview: VFSSearchPreview? = previewExcerpt.map { VFSSearchPreview(excerpt: $0) }; return recordValue(Self.candidType, [("preview", preview.candidValue), ("kind", kind.candidValue), ("path", path.candidValue), ("match_reasons", matchReasons.candidValue), ("snippet", snippet.candidValue), ("score", score.candidValue)]) }
}

extension CreatedDatabase: CandidConvertible {
    static let candidType: CandidType = .record(fields([("status", DatabaseStatus.candidType), ("name", .text), ("initial_free_grant_applied", .bool), ("database_id", .text)]))
    init(candidValue: CandidValue) throws { let r = try CandidRecord(candidValue); status = try r.required("status"); name = try r.required("name"); initialFreeGrantApplied = try r.required("initial_free_grant_applied"); databaseId = try r.required("database_id") }
    var candidValue: CandidValue { recordValue(Self.candidType, [("status", status.candidValue), ("name", name.candidValue), ("initial_free_grant_applied", initialFreeGrantApplied.candidValue), ("database_id", databaseId.candidValue)]) }
}

extension NodePublication: CandidConvertible {
    static let candidType: CandidType = .record(fields([("public_id", .text), ("path", .text), ("published_at_ms", .int64), ("database_id", .text)]))
    init(candidValue: CandidValue) throws { let r = try CandidRecord(candidValue); publicId = try r.required("public_id"); path = try r.required("path"); publishedAtMs = try r.required("published_at_ms"); databaseId = try r.required("database_id") }
    var candidValue: CandidValue { recordValue(Self.candidType, [("public_id", publicId.candidValue), ("path", path.candidValue), ("published_at_ms", publishedAtMs.candidValue), ("database_id", databaseId.candidValue)]) }
}

extension DatabaseMember: CandidConvertible {
    static let candidType: CandidType = .record(fields([("principal", .text), ("role", DatabaseRole.candidType), ("created_at_ms", .int64), ("database_id", .text)]))
    init(candidValue: CandidValue) throws { let r = try CandidRecord(candidValue); principal = try r.required("principal"); role = try r.required("role"); createdAtMs = try r.required("created_at_ms"); let _: String = try r.required("database_id") }
    var candidValue: CandidValue { recordValue(Self.candidType, [("principal", principal.candidValue), ("role", role.candidValue), ("created_at_ms", createdAtMs.candidValue), ("database_id", "".candidValue)]) }
}

extension DatabaseCycleEntry: CandidConvertible {
    static let candidType: CandidType = .record(fields([("method", Optional<String>.candidType), ("payment_amount_e8s", Optional<UInt64>.candidType), ("kind", .text), ("balance_after_cycles", .nat64), ("created_at_ms", .int64), ("cycles_per_kinic", Optional<UInt64>.candidType), ("ledger_block_index", Optional<UInt64>.candidType), ("database_id", .text), ("amount_cycles", .int64), ("caller", .text), ("cycles_delta", Optional<UInt64>.candidType), ("entry_id", .nat64)]))
    init(candidValue: CandidValue) throws { let r = try CandidRecord(candidValue); method = try r.required("method"); paymentAmountE8s = try r.required("payment_amount_e8s"); kind = try r.required("kind"); balanceAfterCycles = try r.required("balance_after_cycles"); createdAtMs = try r.required("created_at_ms"); cyclesPerKinic = try r.required("cycles_per_kinic"); ledgerBlockIndex = try r.required("ledger_block_index"); databaseId = try r.required("database_id"); amountCycles = try r.required("amount_cycles"); caller = try r.required("caller"); cyclesDelta = try r.required("cycles_delta"); entryId = try r.required("entry_id") }
    var candidValue: CandidValue { recordValue(Self.candidType, [("method", method.candidValue), ("payment_amount_e8s", paymentAmountE8s.candidValue), ("kind", kind.candidValue), ("balance_after_cycles", balanceAfterCycles.candidValue), ("created_at_ms", createdAtMs.candidValue), ("cycles_per_kinic", cyclesPerKinic.candidValue), ("ledger_block_index", ledgerBlockIndex.candidValue), ("database_id", databaseId.candidValue), ("amount_cycles", amountCycles.candidValue), ("caller", caller.candidValue), ("cycles_delta", cyclesDelta.candidValue), ("entry_id", entryId.candidValue)]) }
}

extension DatabaseCycleEntryPage: CandidConvertible { static let candidType: CandidType = .record(fields([("entries", [DatabaseCycleEntry].candidType), ("next_cursor", Optional<UInt64>.candidType)])); init(candidValue: CandidValue) throws { let r = try CandidRecord(candidValue); entries = try r.required("entries"); nextCursor = try r.required("next_cursor") }; var candidValue: CandidValue { recordValue(Self.candidType, [("entries", entries.candidValue), ("next_cursor", nextCursor.candidValue)]) } }

extension DatabaseCyclesPendingPurchase: CandidConvertible {
    static let candidType: CandidType = .record(fields([("status", .text), ("payment_amount_e8s", .nat64), ("operation_id", .nat64), ("created_at_ms", .int64), ("required_action", .text), ("ledger_block_index", Optional<UInt64>.candidType), ("database_id", .text), ("amount_cycles", .nat64)]))
    init(candidValue: CandidValue) throws { let r = try CandidRecord(candidValue); status = try r.required("status"); paymentAmountE8s = try r.required("payment_amount_e8s"); operationId = try r.required("operation_id"); createdAtMs = try r.required("created_at_ms"); requiredAction = try r.required("required_action"); ledgerBlockIndex = try r.required("ledger_block_index"); databaseId = try r.required("database_id"); amountCycles = try r.required("amount_cycles") }
    var candidValue: CandidValue { recordValue(Self.candidType, [("status", status.candidValue), ("payment_amount_e8s", paymentAmountE8s.candidValue), ("operation_id", operationId.candidValue), ("created_at_ms", createdAtMs.candidValue), ("required_action", requiredAction.candidValue), ("ledger_block_index", ledgerBlockIndex.candidValue), ("database_id", databaseId.candidValue), ("amount_cycles", amountCycles.candidValue)]) }
}

extension MarketEntitlement: CandidConvertible { static let candidType: CandidType = .record(fields([("status", .text), ("purchased_at_ms", .int64), ("database_id", .text), ("buyer_principal", .text), ("order_id", .text), ("listing_id", .text)])); init(candidValue: CandidValue) throws { let r = try CandidRecord(candidValue); status = try r.required("status"); purchasedAtMs = try r.required("purchased_at_ms"); databaseId = try r.required("database_id"); buyerPrincipal = try r.required("buyer_principal"); orderId = try r.required("order_id"); listingId = try r.required("listing_id") }; var candidValue: CandidValue { recordValue(Self.candidType, [("status", status.candidValue), ("purchased_at_ms", purchasedAtMs.candidValue), ("database_id", databaseId.candidValue), ("buyer_principal", buyerPrincipal.candidValue), ("order_id", orderId.candidValue), ("listing_id", listingId.candidValue)]) } }
extension MarketEntitlementPage: CandidConvertible { static let candidType: CandidType = .record(fields([("next_cursor", Optional<String>.candidType), ("entitlements", [MarketEntitlement].candidType)])); init(candidValue: CandidValue) throws { let r = try CandidRecord(candidValue); nextCursor = try r.required("next_cursor"); entitlements = try r.required("entitlements") }; var candidValue: CandidValue { recordValue(Self.candidType, [("next_cursor", nextCursor.candidValue), ("entitlements", entitlements.candidValue)]) } }

extension VFSNodeMutationErrorCode: CandidConvertible {
    static let candidType: CandidType = .variant(fields([("WriteUnavailable", .null), ("NotFound", .null), ("EtagConflict", .null), ("Forbidden", .null), ("InvalidOperation", .null)]))
    init(candidValue: CandidValue) throws { switch try variantTag(candidValue, type: Self.candidType).0 { case "EtagConflict": self = .etagConflict; case "NotFound": self = .notFound; case "Forbidden": self = .forbidden; case "WriteUnavailable": self = .writeUnavailable; case "InvalidOperation": self = .invalidOperation; default: throw ICClientError.invalidCandid("invalid mutation error code") } }
    var candidValue: CandidValue { variantValue(Self.candidType, tag: self == .etagConflict ? "EtagConflict" : self == .notFound ? "NotFound" : self == .forbidden ? "Forbidden" : self == .writeUnavailable ? "WriteUnavailable" : "InvalidOperation") }
}

extension VFSNodeMutationFailure: CandidConvertible {
    static let candidType: CandidType = .record(fields([("code", VFSNodeMutationErrorCode.candidType), ("conflict_path", Optional<String>.candidType), ("failed_index", Optional<UInt32>.candidType), ("message", .text)]))
    init(candidValue: CandidValue) throws { let r = try CandidRecord(candidValue); code = try r.required("code"); conflictPath = try r.required("conflict_path"); failedIndex = try r.required("failed_index"); message = try r.required("message") }
    var candidValue: CandidValue { recordValue(Self.candidType, [("code", code.candidValue), ("conflict_path", conflictPath.candidValue), ("failed_index", failedIndex.candidValue), ("message", message.candidValue)]) }
}

struct VFSDeleteNodeResult: CandidConvertible {
    let path: String
    static let candidType: CandidType = .record(fields([("path", .text)]))
    init(candidValue: CandidValue) throws { path = try CandidRecord(candidValue).required("path") }
    var candidValue: CandidValue { recordValue(Self.candidType, [("path", path.candidValue)]) }
}

struct VFSNode: Identifiable, Equatable, Sendable {
    let path: String; let kind: VFSNodeKind; let content: String; let metadataJson: String; let etag: String; let createdAt: Int64; let updatedAt: Int64
    var id: String { path }
}

struct VFSNodeMutationAck: Equatable, Sendable { let path: String; let kind: VFSNodeKind; let updatedAt: Int64; let etag: String }
struct VFSWriteNodeResult: Equatable, Sendable { let created: Bool; let node: VFSNodeMutationAck }
