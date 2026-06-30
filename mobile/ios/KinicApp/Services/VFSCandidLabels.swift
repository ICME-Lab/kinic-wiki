// Where: mobile/ios/KinicApp/Services/VFSCandidLabels.swift
// What: Candid record and variant label hashing for VFS-only calls.
// Why: Candid encodes field names as numeric hashes on the wire.

import Foundation

enum VFSCandidLabels {
    static func id(_ label: String) -> UInt32 {
        var hash: UInt32 = 0
        for byte in label.utf8 {
            hash = hash &* 223 &+ UInt32(byte)
        }
        return hash
    }
}
