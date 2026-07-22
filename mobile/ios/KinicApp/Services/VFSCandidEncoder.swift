// Where: mobile/ios/KinicApp/Services/VFSCandidEncoder.swift
// What: Minimal Candid encoder for Kinic VFS source capture methods.
// Why: ICNativeClient transports raw args; the app needs only a small VFS-specific codec.

import Foundation

enum VFSCandidEncoder {
    private static let magic = Data([0x44, 0x49, 0x44, 0x4c])
    private static let typeNull: Int64 = -1
    private static let typeBool: Int64 = -2
    private static let typeNat32: Int64 = -7
    private static let typeNat64: Int64 = -8
    private static let typeText: Int64 = -15
    private static let typeOpt: Int64 = -18
    private static let typeVec: Int64 = -19
    private static let typeRecord: Int64 = -20
    private static let typeVariant: Int64 = -21

    static func empty() -> Data {
        var data = magic
        appendUnsigned(0, to: &data)
        appendUnsigned(0, to: &data)
        return data
    }

    static func textArgsForDatabase(_ databaseId: String) -> Data {
        textArgs([databaseId])
    }

    static func mkdirNode(databaseId: String, path: String) -> Data {
        oneRecord(
            tableEntries: [
                record([
                    field("path", primitive(typeText)),
                    field("database_id", primitive(typeText))
                ])
            ],
            argType: table(0),
            values: [
                .text(path),
                .text(databaseId)
            ]
        )
    }

    static func readNode(databaseId: String, path: String) -> Data {
        textArgs([databaseId, path])
    }

    static func listChildren(databaseId: String, path: String) -> Data {
        oneRecord(
            tableEntries: [
                record([
                    field("path", primitive(typeText)),
                    field("database_id", primitive(typeText))
                ])
            ],
            argType: table(0),
            namedValues: [
                ("path", .text(path)),
                ("database_id", .text(databaseId))
            ]
        )
    }

    static func searchNodes(databaseId: String, query: String, prefix: String?, topK: UInt32) -> Data {
        let optionalText = opt(primitive(typeText))
        let previewMode = variant([
            field("Light", primitive(typeNull)),
            field("ContentStart", primitive(typeNull)),
            field("None", primitive(typeNull))
        ])
        let optionalPreviewMode = opt(table(1))
        let searchRequest = record([
            field("top_k", primitive(typeNat32)),
            field("database_id", primitive(typeText)),
            field("preview_mode", table(2)),
            field("prefix", table(0)),
            field("query_text", primitive(typeText))
        ])
        return oneRecord(
            tableEntries: [optionalText, previewMode, optionalPreviewMode, searchRequest],
            argType: table(3),
            namedValues: [
                ("top_k", .nat32(topK)),
                ("database_id", .text(databaseId)),
                ("preview_mode", .some(.variant("Light", ["Light", "ContentStart", "None"], .null))),
                ("prefix", prefix.map { .some(.text($0)) } ?? .none),
                ("query_text", .text(query))
            ]
        )
    }

    static func createDatabase(name: String) -> Data {
        oneRecord(
            tableEntries: [
                record([
                    field("name", primitive(typeText))
                ])
            ],
            argType: table(0),
            values: [
                .text(name)
            ]
        )
    }

    static func updateDatabaseMetadata(databaseId: String, name: String, description: String, llmSummary: String?, tagsJson: String) -> Data {
        let optionalText = opt(primitive(typeText))
        let metadataRequest = record([
            field("llm_summary", table(0)),
            field("name", primitive(typeText)),
            field("description", primitive(typeText)),
            field("database_id", primitive(typeText)),
            field("tags_json", primitive(typeText))
        ])
        return oneRecord(
            tableEntries: [optionalText, metadataRequest],
            argType: table(1),
            namedValues: [
                ("llm_summary", llmSummary.map { .some(.text($0)) } ?? .none),
                ("name", .text(name)),
                ("description", .text(description)),
                ("database_id", .text(databaseId)),
                ("tags_json", .text(tagsJson))
            ]
        )
    }

    static func grantDatabaseAccess(databaseId: String, principal: String, role: DatabaseRole) -> Data {
        let roleVariant = variant([
            field("Owner", primitive(typeNull)),
            field("Writer", primitive(typeNull)),
            field("Reader", primitive(typeNull))
        ])
        var data = magic
        appendUnsigned(1, to: &data)
        encode(roleVariant, to: &data)
        appendUnsigned(3, to: &data)
        encode(primitive(typeText), to: &data)
        encode(primitive(typeText), to: &data)
        encode(table(0), to: &data)
        encode(.text(databaseId), to: &data)
        encode(.text(principal), to: &data)
        encode(.variant(role.candidName, ["Owner", "Writer", "Reader"], .null), to: &data)
        return data
    }

    static func revokeDatabaseAccess(databaseId: String, principal: String) -> Data {
        textArgs([databaseId, principal])
    }

    static func listDatabaseCycleEntries(databaseId: String, cursor: UInt64?, limit: UInt32) -> Data {
        var data = magic
        appendUnsigned(1, to: &data)
        encode(opt(primitive(typeNat64)), to: &data)
        appendUnsigned(3, to: &data)
        encode(primitive(typeText), to: &data)
        encode(table(0), to: &data)
        encode(primitive(typeNat32), to: &data)
        encode(.text(databaseId), to: &data)
        encode(cursor.map { .some(.nat64($0)) } ?? .none, to: &data)
        encode(.nat32(limit), to: &data)
        return data
    }

    static func marketListEntitlements(cursor: String?, limit: UInt32) -> Data {
        var data = magic
        appendUnsigned(1, to: &data)
        encode(opt(primitive(typeText)), to: &data)
        appendUnsigned(2, to: &data)
        encode(table(0), to: &data)
        encode(primitive(typeNat32), to: &data)
        encode(cursor.map { .some(.text($0)) } ?? .none, to: &data)
        encode(.nat32(limit), to: &data)
        return data
    }

    static func deleteDatabase(databaseId: String) -> Data {
        oneRecord(
            tableEntries: [
                record([
                    field("database_id", primitive(typeText))
                ])
            ],
            argType: table(0),
            values: [
                .text(databaseId)
            ]
        )
    }

    static func authorizeSourceCaptureTriggerSession(databaseId: String, sessionNonce: String) -> Data {
        oneRecord(
            tableEntries: [
                record([
                    field("database_id", primitive(typeText)),
                    field("session_nonce", primitive(typeText))
                ])
            ],
            argType: table(0),
            values: [
                .text(sessionNonce),
                .text(databaseId)
            ]
        )
    }

    static func writeNode(_ request: SourceCaptureRequest) -> Data {
        writeNode(
            databaseId: request.databaseId,
            path: request.requestPath,
            kind: .file,
            content: request.content,
            metadataJson: request.metadataJson,
            expectedEtag: nil
        )
    }

    static func writeNode(
        databaseId: String,
        path: String,
        kind: VFSNodeKind,
        content: String,
        metadataJson: String,
        expectedEtag: String?
    ) -> Data {
        let kindName: String
        switch kind {
        case .file:
            kindName = "File"
        case .source:
            kindName = "Source"
        case .folder:
            kindName = "Folder"
        }
        let nodeKind = variant([
            field("File", primitive(typeNull)),
            field("Source", primitive(typeNull)),
            field("Folder", primitive(typeNull))
        ])
        let optionalText = opt(primitive(typeText))
        let writeRequest = record([
            field("content", primitive(typeText)),
            field("kind", table(0)),
            field("path", primitive(typeText)),
            field("expected_etag", table(1)),
            field("metadata_json", primitive(typeText)),
            field("database_id", primitive(typeText))
        ])
        return oneRecord(
            tableEntries: [nodeKind, optionalText, writeRequest],
            argType: table(2),
            values: [
                .text(content),
                .variant(kindName, ["File", "Source", "Folder"], .null),
                .text(path),
                expectedEtag.map { .some(.text($0)) } ?? .none,
                .text(metadataJson),
                .text(databaseId)
            ]
        )
    }

    static func writeNodes(_ request: SourceCaptureRequest) -> Data {
        let nodeKind = variant([
            field("File", primitive(typeNull)),
            field("Source", primitive(typeNull)),
            field("Folder", primitive(typeNull))
        ])
        let optionalText = opt(primitive(typeText))
        let writeNodeItem = record([
            field("content", primitive(typeText)),
            field("kind", table(0)),
            field("path", primitive(typeText)),
            field("expected_etag", table(1)),
            field("metadata_json", primitive(typeText))
        ])
        let writeNodeItems = vec(table(2))
        let writeNodesRequest = record([
            field("nodes", table(3)),
            field("database_id", primitive(typeText))
        ])
        return oneRecord(
            tableEntries: [nodeKind, optionalText, writeNodeItem, writeNodeItems, writeNodesRequest],
            argType: table(4),
            namedValues: [
                ("nodes", .vector([
                    .record([
                        ("content", .text(request.content)),
                        ("kind", .variant("File", ["File", "Source", "Folder"], .null)),
                        ("path", .text(request.requestPath)),
                        ("expected_etag", .none),
                        ("metadata_json", .text(request.metadataJson))
                    ])
                ])),
                ("database_id", .text(request.databaseId))
            ]
        )
    }

    private static func oneRecord(tableEntries: [TypeEntry], argType: TypeRef, namedValues: [(String, Value)]) -> Data {
        oneRecord(
            tableEntries: tableEntries,
            argType: argType,
            values: namedValues.sorted { label($0.0) < label($1.0) }.map(\.1)
        )
    }

    private static func oneRecord(tableEntries: [TypeEntry], argType: TypeRef, values: [Value]) -> Data {
        var data = magic
        appendUnsigned(UInt64(tableEntries.count), to: &data)
        for entry in tableEntries {
            encode(entry, to: &data)
        }
        appendUnsigned(1, to: &data)
        encode(argType, to: &data)
        for value in values {
            encode(value, to: &data)
        }
        return data
    }

    private static func textArgs(_ texts: [String]) -> Data {
        var data = magic
        appendUnsigned(0, to: &data)
        appendUnsigned(UInt64(texts.count), to: &data)
        for _ in texts {
            appendSigned(typeText, to: &data)
        }
        for text in texts {
            let bytes = Data(text.utf8)
            appendUnsigned(UInt64(bytes.count), to: &data)
            data.append(bytes)
        }
        return data
    }

    private static func record(_ fields: [Field]) -> TypeEntry {
        .record(fields.sorted { $0.id < $1.id })
    }

    private static func variant(_ fields: [Field]) -> TypeEntry {
        .variant(fields.sorted { $0.id < $1.id })
    }

    private static func opt(_ type: TypeRef) -> TypeEntry {
        .opt(type)
    }

    private static func vec(_ type: TypeRef) -> TypeEntry {
        .vec(type)
    }

    private static func field(_ name: String, _ type: TypeRef) -> Field {
        Field(id: VFSCandidLabels.id(name), name: name, type: type)
    }

    private static func label(_ name: String) -> UInt32 {
        VFSCandidLabels.id(name)
    }

    private static func primitive(_ value: Int64) -> TypeRef {
        .primitive(value)
    }

    private static func table(_ index: Int64) -> TypeRef {
        .table(index)
    }

    private static func encode(_ entry: TypeEntry, to data: inout Data) {
        switch entry {
        case .record(let fields):
            appendSigned(typeRecord, to: &data)
            appendUnsigned(UInt64(fields.count), to: &data)
            for field in fields {
                appendUnsigned(UInt64(field.id), to: &data)
                encode(field.type, to: &data)
            }
        case .variant(let fields):
            appendSigned(typeVariant, to: &data)
            appendUnsigned(UInt64(fields.count), to: &data)
            for field in fields {
                appendUnsigned(UInt64(field.id), to: &data)
                encode(field.type, to: &data)
            }
        case .opt(let type):
            appendSigned(typeOpt, to: &data)
            encode(type, to: &data)
        case .vec(let type):
            appendSigned(typeVec, to: &data)
            encode(type, to: &data)
        }
    }

    private static func encode(_ type: TypeRef, to data: inout Data) {
        switch type {
        case .primitive(let value), .table(let value):
            appendSigned(value, to: &data)
        }
    }

    private static func encode(_ value: Value, to data: inout Data) {
        switch value {
        case .null:
            break
        case .nat32(let value):
            appendFixedUInt32(value, to: &data)
        case .nat64(let value):
            appendFixedUInt64(value, to: &data)
        case .text(let text):
            let bytes = Data(text.utf8)
            appendUnsigned(UInt64(bytes.count), to: &data)
            data.append(bytes)
        case .record(let fields):
            for field in fields.sorted(by: { label($0.0) < label($1.0) }) {
                encode(field.1, to: &data)
            }
        case .vector(let values):
            appendUnsigned(UInt64(values.count), to: &data)
            for value in values {
                encode(value, to: &data)
            }
        case .variant(let label, let cases, let inner):
            let fields = cases.sorted { VFSCandidLabels.id($0) < VFSCandidLabels.id($1) }
            let index = fields.firstIndex(of: label) ?? 0
            appendUnsigned(UInt64(index), to: &data)
            encode(inner, to: &data)
        case .some(let inner):
            data.append(1)
            encode(inner, to: &data)
        case .none:
            data.append(0)
        }
    }

    private static func appendUnsigned(_ value: UInt64, to data: inout Data) {
        VFSCandidLEB.appendUnsigned(value, to: &data)
    }

    private static func appendSigned(_ value: Int64, to data: inout Data) {
        VFSCandidLEB.appendSigned(value, to: &data)
    }

    private static func appendFixedUInt32(_ value: UInt32, to data: inout Data) {
        for offset in 0..<4 {
            data.append(UInt8(truncatingIfNeeded: value >> UInt32(offset * 8)))
        }
    }

    private static func appendFixedUInt64(_ value: UInt64, to data: inout Data) {
        for offset in 0..<8 {
            data.append(UInt8(truncatingIfNeeded: value >> UInt64(offset * 8)))
        }
    }

    private struct Field {
        let id: UInt32
        let name: String
        let type: TypeRef
    }

    private enum TypeRef {
        case primitive(Int64)
        case table(Int64)
    }

    private enum TypeEntry {
        case record([Field])
        case variant([Field])
        case opt(TypeRef)
        case vec(TypeRef)
    }

    private indirect enum Value {
        case null
        case nat32(UInt32)
        case nat64(UInt64)
        case text(String)
        case record([(String, Value)])
        case vector([Value])
        case variant(String, [String], Value)
        case some(Value)
        case none
    }
}
