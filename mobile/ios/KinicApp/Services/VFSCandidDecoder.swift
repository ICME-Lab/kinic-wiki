// Where: mobile/ios/KinicApp/Services/VFSCandidDecoder.swift
// What: Minimal Candid decoder for Kinic VFS replies.
// Why: The app only needs Result variants for database listing and source capture writes.

import Foundation

enum VFSCandidDecoder {
    private static let magic = Data([0x44, 0x49, 0x44, 0x4c])
    private static let typeNull: Int64 = -1
    private static let typeBool: Int64 = -2
    private static let typeNat64: Int64 = -8
    private static let typeInt64: Int64 = -12
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

    static func decodeMkdirNodeResult(_ data: Data) throws {
        let ok = try decodeResult(data)
        guard case .record = ok else {
            throw VFSCandidError.invalidPayload("expected mkdir_node result")
        }
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
        let metadata = try record(fields, "metadata")
        return DatabaseSummary(
            databaseId: try text(fields, "database_id"),
            title: try text(metadata, "title"),
            description: try text(metadata, "description"),
            role: try databaseRole(from: variant(fields, "role")),
            status: try databaseStatus(from: variant(fields, "status"))
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

    private static func record(_ fields: [UInt32: Value], _ name: String) throws -> [UInt32: Value] {
        guard let value = fields[label(name)],
              case .record(let child) = value else {
            throw VFSCandidError.invalidPayload("missing record field \(name)")
        }
        return child
    }

    private static func text(_ fields: [UInt32: Value], _ name: String) throws -> String {
        guard let value = fields[label(name)],
              case .text(let text) = value else {
            throw VFSCandidError.invalidPayload("missing text field \(name)")
        }
        return text
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
            case typeNat64:
                return .nat64(try readFixedUInt64())
            case typeInt64:
                return .int64(try readFixedInt64())
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

        private mutating func readFixedInt64() throws -> Int64 {
            let unsigned = try readFixedUInt64()
            return Int64(bitPattern: unsigned)
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
        case nat64(UInt64)
        case int64(Int64)
        case opt(Value?)
        case vector([Value])
        case record([UInt32: Value])
        case variant(UInt32, Value)
    }
}
