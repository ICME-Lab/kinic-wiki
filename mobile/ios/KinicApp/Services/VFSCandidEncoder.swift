// Where: mobile/ios/KinicApp/Services/VFSCandidEncoder.swift
// What: Minimal Candid encoder for Kinic VFS source capture methods.
// Why: ICNativeClient transports raw args; the app needs only a small VFS-specific codec.

import Foundation

enum VFSCandidEncoder {
    private static let magic = Data([0x44, 0x49, 0x44, 0x4c])
    private static let typeNull: Int64 = -1
    private static let typeBool: Int64 = -2
    private static let typeText: Int64 = -15
    private static let typeOpt: Int64 = -18
    private static let typeRecord: Int64 = -20
    private static let typeVariant: Int64 = -21

    static func empty() -> Data {
        var data = magic
        appendUnsigned(0, to: &data)
        appendUnsigned(0, to: &data)
        return data
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
                .text(request.content),
                .variant("File", .null),
                .text(request.requestPath),
                .none,
                .text(request.metadataJson),
                .text(request.databaseId)
            ]
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

    private static func record(_ fields: [Field]) -> TypeEntry {
        .record(fields.sorted { $0.id < $1.id })
    }

    private static func variant(_ fields: [Field]) -> TypeEntry {
        .variant(fields.sorted { $0.id < $1.id })
    }

    private static func opt(_ type: TypeRef) -> TypeEntry {
        .opt(type)
    }

    private static func field(_ name: String, _ type: TypeRef) -> Field {
        Field(id: VFSCandidLabels.id(name), name: name, type: type)
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
        case .text(let text):
            let bytes = Data(text.utf8)
            appendUnsigned(UInt64(bytes.count), to: &data)
            data.append(bytes)
        case .variant(let label, let inner):
            let fields = ["File", "Source", "Folder"].sorted { VFSCandidLabels.id($0) < VFSCandidLabels.id($1) }
            let index = fields.firstIndex(of: label) ?? 0
            appendUnsigned(UInt64(index), to: &data)
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
    }

    private indirect enum Value {
        case null
        case text(String)
        case variant(String, Value)
        case none
    }
}
