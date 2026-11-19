import Foundation

public enum VaultCryptoError: Error, Equatable, Sendable {
    case invalidContext
    case invalidPrincipal
    case invalidInput
    case invalidEncoding
    case invalidEnvelope
    case invalidManifest
    case invalidMetadata
    case sizeLimit
    case missingChunk
    case corruptChunk
    case invalidExtent
    case invalidTotpSecret
    case invalidTotpUri
    case unsupportedOtpType
    case unsupportedTotpAlgorithm
    case invalidTotpDigits
    case invalidTotpPeriod
    case randomFailure
}

/// Decodes a canonical Internet Computer textual principal (CRC32 + Base32) into raw bytes.
public enum ICPPrincipalCodec {
    private static let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")

    public static func decodeText(_ text: String) throws -> Data {
        let stripped = text.lowercased().replacingOccurrences(of: "-", with: "")
        guard !stripped.isEmpty else { throw VaultCryptoError.invalidPrincipal }
        let decoded = try decodeBase32Raw(stripped.uppercased())
        guard decoded.count >= 4 else { throw VaultCryptoError.invalidPrincipal }
        let checksum = decoded.prefix(4)
        let body = Data(decoded.dropFirst(4))
        guard !body.isEmpty, body.count <= 29 else { throw VaultCryptoError.invalidPrincipal }
        // Reject anonymous principal (single byte 0x04)
        if body.count == 1 && body[0] == 0x04 {
            throw VaultCryptoError.invalidContext
        }
        let expected = crc32(body)
        var expectedBytes = Data(count: 4)
        expectedBytes[0] = UInt8((expected >> 24) & 0xff)
        expectedBytes[1] = UInt8((expected >> 16) & 0xff)
        expectedBytes[2] = UInt8((expected >> 8) & 0xff)
        expectedBytes[3] = UInt8(expected & 0xff)
        guard checksum == expectedBytes else { throw VaultCryptoError.invalidPrincipal }
        return body
    }

    static func decodeBase32Raw(_ input: String) throws -> Data {
        var bits = 0
        var value = 0
        var out = Data()
        for ch in input {
            guard let idx = alphabet.firstIndex(of: ch) else {
                throw VaultCryptoError.invalidEncoding
            }
            value = (value << 5) | idx
            bits += 5
            if bits >= 8 {
                bits -= 8
                out.append(UInt8((value >> bits) & 0xff))
            }
        }
        return out
    }

    private static func crc32(_ data: Data) -> UInt32 {
        var crc: UInt32 = 0xffffffff
        for byte in data {
            crc ^= UInt32(byte)
            for _ in 0..<8 {
                if (crc & 1) != 0 {
                    crc = (crc >> 1) ^ 0xedb88320
                } else {
                    crc >>= 1
                }
            }
        }
        return ~crc
    }
}

public struct VaultContext: Equatable, Sendable, Codable {
    public let canister: String
    public let owner: String
    public let vault: Data
    public let nonce: Data
    public let keyName: String

    public init(canister: String, owner: String, vault: Data, nonce: Data, keyName: String) throws {
        let canisterBytes = try ICPPrincipalCodec.decodeText(canister)
        let ownerBytes = try ICPPrincipalCodec.decodeText(owner)
        let keyNameBytes = Data(keyName.utf8)
        guard !canisterBytes.isEmpty,
              !ownerBytes.isEmpty,
              vault.count == 16,
              nonce.count == 32,
              !keyNameBytes.isEmpty,
              keyNameBytes.count <= 64
        else {
            throw VaultCryptoError.invalidContext
        }
        self.canister = canister
        self.owner = owner
        self.vault = vault
        self.nonce = nonce
        self.keyName = keyName
    }

    public func contextInput() throws -> Data {
        let canisterBytes = try ICPPrincipalCodec.decodeText(canister)
        let ownerBytes = try ICPPrincipalCodec.decodeText(owner)
        let keyNameBytes = Data(keyName.utf8)
        return Self.concatSized([
            canisterBytes,
            ownerBytes,
            vault,
            nonce,
            keyNameBytes,
        ])
    }

    public enum DocumentUsage: String, Sendable {
        case dek
        case metadata
        case chunk
    }

    public func documentAAD(
        object: Data,
        revision: UInt64,
        usage: DocumentUsage,
        index: UInt32 = 0
    ) throws -> Data {
        guard object.count == 16 else { throw VaultCryptoError.invalidInput }
        var revBE = revision.bigEndian
        let revData = Data(bytes: &revBE, count: 8)
        var idxBE = index.bigEndian
        let idxData = Data(bytes: &idxBE, count: 4)
        return Self.concatSized([
            Data("kinic-vault/document/v3".utf8),
            try contextInput(),
            object,
            revData,
            Data(usage.rawValue.utf8),
            idxData,
        ])
    }

    private static func concatSized(_ parts: [Data]) -> Data {
        var out = Data()
        for part in parts {
            var lenBE = UInt32(part.count).bigEndian
            out.append(Data(bytes: &lenBE, count: 4))
            out.append(part)
        }
        return out
    }
}

public enum Base64URL {
    public static func encode(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    public static func decode(_ string: String) throws -> Data {
        guard string.allSatisfy({ ch in
            ch.isASCII && (ch.isLetter || ch.isNumber || ch == "-" || ch == "_")
        }) else {
            throw VaultCryptoError.invalidEncoding
        }
        var standard = string
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let remainder = standard.count % 4
        if remainder == 1 { throw VaultCryptoError.invalidEncoding }
        if remainder > 0 {
            standard += String(repeating: "=", count: 4 - remainder)
        }
        guard let decoded = Data(base64Encoded: standard), encode(decoded) == string else {
            throw VaultCryptoError.invalidEncoding
        }
        return decoded
    }
}
