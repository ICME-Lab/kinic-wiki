// Where: mobile/ios/KinicApp/Services/VFSCandidLEB.swift
// What: LEB128 primitives required by the VFS Candid codec.
// Why: Candid uses LEB128 for type IDs, field IDs, lengths, and integers.

import Foundation

enum VFSCandidLEB {
    static func appendUnsigned(_ value: UInt64, to data: inout Data) {
        var remaining = value
        repeat {
            var byte = UInt8(remaining & 0x7f)
            remaining >>= 7
            if remaining != 0 {
                byte |= 0x80
            }
            data.append(byte)
        } while remaining != 0
    }

    static func appendSigned(_ value: Int64, to data: inout Data) {
        var remaining = value
        var more = true
        while more {
            var byte = UInt8(truncatingIfNeeded: remaining) & 0x7f
            remaining >>= 7
            let signBitSet = (byte & 0x40) != 0
            if (remaining == 0 && !signBitSet) || (remaining == -1 && signBitSet) {
                more = false
            } else {
                byte |= 0x80
            }
            data.append(byte)
        }
    }

    static func readUnsigned(from data: Data, offset: inout Int) throws -> UInt64 {
        var result: UInt64 = 0
        var shift: UInt64 = 0
        while true {
            guard offset < data.count else {
                throw VFSCandidError.invalidPayload("unexpected end of unsigned LEB128")
            }
            let byte = data[offset]
            offset += 1
            result |= UInt64(byte & 0x7f) << shift
            if (byte & 0x80) == 0 {
                return result
            }
            shift += 7
            if shift > 63 {
                throw VFSCandidError.invalidPayload("unsigned LEB128 is too large")
            }
        }
    }

    static func readSigned(from data: Data, offset: inout Int) throws -> Int64 {
        var result: Int64 = 0
        var shift: Int64 = 0
        var byte: UInt8 = 0
        repeat {
            guard offset < data.count else {
                throw VFSCandidError.invalidPayload("unexpected end of signed LEB128")
            }
            byte = data[offset]
            offset += 1
            result |= Int64(byte & 0x7f) << shift
            shift += 7
            if shift > 70 {
                throw VFSCandidError.invalidPayload("signed LEB128 is too large")
            }
        } while (byte & 0x80) != 0

        if shift < 64 && (byte & 0x40) != 0 {
            result |= (-1) << shift
        }
        return result
    }
}
