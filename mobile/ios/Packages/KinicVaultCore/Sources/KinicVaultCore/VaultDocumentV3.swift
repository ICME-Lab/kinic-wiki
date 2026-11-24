import CryptoKit
import Foundation

public enum VaultDocumentKind: String, Codable, Equatable, Sendable {
    case note
    case credential
    case attachment
}

public struct VaultMetadata: Codable, Equatable, Sendable {
    public let kind: VaultDocumentKind
    public let title: String
    public let filename: String?
    public let mime: String?
    public let username: String?
    public let domains: [String]?
    public let hasTotp: Bool?
    public let favorite: Bool?
    public let tags: [String]?

    public init(
        kind: VaultDocumentKind,
        title: String,
        filename: String? = nil,
        mime: String? = nil,
        username: String? = nil,
        domains: [String]? = nil,
        hasTotp: Bool? = nil,
        favorite: Bool? = nil,
        tags: [String]? = nil
    ) {
        self.kind = kind
        self.title = title
        self.filename = filename
        self.mime = mime
        self.username = username
        self.domains = domains
        self.hasTotp = hasTotp
        self.favorite = favorite
        self.tags = tags
    }

    /// v3 metadata limits use UTF-16 code units, as in the Web client.
    public static func truncateText(_ text: String, limit: Int) -> String {
        var remaining = limit
        return String(text.prefix { character in
            remaining -= character.utf16.count
            return remaining >= 0
        })
    }

    func validate() throws {
        guard title.utf16.count <= 512 else { throw VaultCryptoError.invalidMetadata }
        if let username, username.utf16.count > 256 {
            throw VaultCryptoError.invalidMetadata
        }
        if let domains {
            guard domains.count <= 32,
                  domains.allSatisfy({ !$0.isEmpty && $0.utf16.count <= 255 })
            else {
                throw VaultCryptoError.invalidMetadata
            }
        }
        if let tags {
            guard tags.count <= 32,
                  tags.allSatisfy({ !$0.isEmpty && $0.utf16.count <= 64 })
            else {
                throw VaultCryptoError.invalidMetadata
            }
        }
    }
}

public struct VaultEnvelopeJSON: Codable, Equatable, Sendable {
    public let version: Int
    public let nonce: String
    public let ciphertext: String
}

public struct VaultManifestV3: Codable, Equatable, Sendable {
    public let version: Int
    public let dek: VaultEnvelopeJSON
    public let metadata: VaultEnvelopeJSON
    public let nonces: [String]
}

private struct VaultMetadataPayload: Codable {
    let metadata: VaultMetadata
    let plaintext_length: Int
    let chunk_count: Int
}

public struct EncryptedVaultDocumentV3: Sendable {
    public let manifest: Data
    public let chunks: [Data]
    public let hashes: [Data]
}

public struct ParsedVaultManifestV3: Sendable {
    public let manifest: VaultManifestV3
    public let dek: SymmetricKey
    public let metadata: VaultMetadata
    public let plaintextLength: Int
    public let chunkCount: Int
}

public struct DecryptedVaultDocumentV3: Sendable {
    public let metadata: VaultMetadata
    public let plaintext: Data
}

public enum VaultDocumentV3 {
    public static let chunkSize = 1_048_576
    public static let maxMetadataBytes = 8_192
    public static let maxNoteBytes = 256 * 1024
    public static let maxAttachmentBytes = 10 * 1_048_576

    public static func encrypt(
        rootKey: SymmetricKey,
        context: VaultContext,
        object: Data,
        revision: UInt64,
        metadata: VaultMetadata,
        plaintext: Data
    ) throws -> EncryptedVaultDocumentV3 {
        try metadata.validate()
        try validateLength(metadata: metadata, length: plaintext.count)
        let count = max(1, Int(ceil(Double(plaintext.count) / Double(chunkSize))))

        let payload = VaultMetadataPayload(
            metadata: metadata,
            plaintext_length: plaintext.count,
            chunk_count: count
        )
        let encoder = JSONEncoder()
        let metaBytes = try encoder.encode(payload)
        guard metaBytes.count <= maxMetadataBytes else {
            throw VaultCryptoError.sizeLimit
        }

        let dek = SymmetricKey(size: .bits256)
        let rawDEK = dek.withUnsafeBytes { Data($0) }
        let sealedDEK = try seal(
            key: rootKey,
            plaintext: rawDEK,
            aad: try context.documentAAD(object: object, revision: revision, usage: .dek)
        )
        let sealedMeta = try seal(
            key: dek,
            plaintext: metaBytes,
            aad: try context.documentAAD(object: object, revision: revision, usage: .metadata)
        )

        var chunks: [Data] = []
        var hashes: [Data] = []
        var nonces: [String] = []

        for i in 0..<count {
            let start = i * chunkSize
            let end = min(plaintext.count, start + chunkSize)
            let slice = start < end ? plaintext[start..<end] : Data()
            let sealed = try seal(
                key: dek,
                plaintext: Data(slice),
                aad: try context.documentAAD(
                    object: object,
                    revision: revision,
                    usage: .chunk,
                    index: UInt32(i)
                )
            )
            let cipherData = try Base64URL.decode(sealed.ciphertext)
            chunks.append(cipherData)
            hashes.append(Data(SHA256.hash(data: cipherData)))
            nonces.append(sealed.nonce)
        }

        let manifestObj = VaultManifestV3(
            version: 3,
            dek: sealedDEK,
            metadata: sealedMeta,
            nonces: nonces
        )
        let manifestBytes = try encoder.encode(manifestObj)
        return EncryptedVaultDocumentV3(manifest: manifestBytes, chunks: chunks, hashes: hashes)
    }

    public static func readManifest(
        rootKey: SymmetricKey,
        context: VaultContext,
        object: Data,
        revision: UInt64,
        manifestBytes: Data
    ) throws -> ParsedVaultManifestV3 {
        guard manifestBytes.count <= 65_536 else { throw VaultCryptoError.invalidManifest }
        let manifest: VaultManifestV3
        do {
            manifest = try JSONDecoder().decode(VaultManifestV3.self, from: manifestBytes)
        } catch {
            throw VaultCryptoError.invalidManifest
        }
        guard manifest.version == 3,
              manifest.nonces.count >= 1,
              manifest.nonces.count <= 10
        else {
            throw VaultCryptoError.invalidManifest
        }
        for nonce in manifest.nonces {
            guard try Base64URL.decode(nonce).count == 12 else {
                throw VaultCryptoError.invalidManifest
            }
        }

        let rawDEK = try open(
            key: rootKey,
            envelope: manifest.dek,
            aad: try context.documentAAD(object: object, revision: revision, usage: .dek)
        )
        guard rawDEK.count == 32 else { throw VaultCryptoError.invalidEnvelope }
        let dek = SymmetricKey(data: rawDEK)

        let metaPlain = try open(
            key: dek,
            envelope: manifest.metadata,
            aad: try context.documentAAD(object: object, revision: revision, usage: .metadata)
        )
        guard metaPlain.count <= maxMetadataBytes else {
            throw VaultCryptoError.invalidMetadata
        }
        let payload: VaultMetadataPayload
        do {
            payload = try JSONDecoder().decode(VaultMetadataPayload.self, from: metaPlain)
        } catch {
            throw VaultCryptoError.invalidMetadata
        }
        try payload.metadata.validate()
        try validateLength(metadata: payload.metadata, length: payload.plaintext_length)
        let expectedChunks = max(1, Int(ceil(Double(payload.plaintext_length) / Double(chunkSize))))
        guard payload.chunk_count == expectedChunks,
              payload.chunk_count == manifest.nonces.count
        else {
            throw VaultCryptoError.invalidMetadata
        }

        return ParsedVaultManifestV3(
            manifest: manifest,
            dek: dek,
            metadata: payload.metadata,
            plaintextLength: payload.plaintext_length,
            chunkCount: payload.chunk_count
        )
    }

    public static func decrypt(
        rootKey: SymmetricKey,
        context: VaultContext,
        object: Data,
        revision: UInt64,
        manifestBytes: Data,
        chunks: [Data],
        hashes: [Data]
    ) throws -> DecryptedVaultDocumentV3 {
        let parsed = try readManifest(
            rootKey: rootKey,
            context: context,
            object: object,
            revision: revision,
            manifestBytes: manifestBytes
        )
        guard chunks.count == parsed.chunkCount, hashes.count == parsed.chunkCount else {
            throw VaultCryptoError.missingChunk
        }

        var plaintext = Data()
        plaintext.reserveCapacity(parsed.plaintextLength)
        for i in 0..<chunks.count {
            let actualHash = Data(SHA256.hash(data: chunks[i]))
            guard actualHash == hashes[i] else {
                throw VaultCryptoError.corruptChunk
            }
            let envelope = VaultEnvelopeJSON(
                version: 3,
                nonce: parsed.manifest.nonces[i],
                ciphertext: Base64URL.encode(chunks[i])
            )
            let part = try open(
                key: parsed.dek,
                envelope: envelope,
                aad: try context.documentAAD(
                    object: object,
                    revision: revision,
                    usage: .chunk,
                    index: UInt32(i)
                )
            )
            let expectedLength = i < chunks.count - 1
                ? chunkSize
                : parsed.plaintextLength - i * chunkSize
            guard part.count == expectedLength else {
                throw VaultCryptoError.invalidExtent
            }
            plaintext.append(part)
        }
        return DecryptedVaultDocumentV3(metadata: parsed.metadata, plaintext: plaintext)
    }

    private static func validateLength(metadata: VaultMetadata, length: Int) throws {
        let limit = metadata.kind == .attachment ? maxAttachmentBytes : maxNoteBytes
        guard length >= 0, length <= limit else {
            throw VaultCryptoError.sizeLimit
        }
    }

    private static func seal(
        key: SymmetricKey,
        plaintext: Data,
        aad: Data
    ) throws -> VaultEnvelopeJSON {
        let nonce = AES.GCM.Nonce()
        let box = try AES.GCM.seal(plaintext, using: key, nonce: nonce, authenticating: aad)
        var combinedCipherAndTag = Data()
        combinedCipherAndTag.reserveCapacity(box.ciphertext.count + box.tag.count)
        combinedCipherAndTag.append(box.ciphertext)
        combinedCipherAndTag.append(box.tag)
        return VaultEnvelopeJSON(
            version: 3,
            nonce: Base64URL.encode(Data(nonce)),
            ciphertext: Base64URL.encode(combinedCipherAndTag)
        )
    }

    private static func open(
        key: SymmetricKey,
        envelope: VaultEnvelopeJSON,
        aad: Data
    ) throws -> Data {
        guard envelope.version == 3 else { throw VaultCryptoError.invalidEnvelope }
        let nonceBytes = try Base64URL.decode(envelope.nonce)
        let cipherAndTag = try Base64URL.decode(envelope.ciphertext)
        guard nonceBytes.count == 12, cipherAndTag.count >= 16 else {
            throw VaultCryptoError.invalidEnvelope
        }
        let nonce = try AES.GCM.Nonce(data: nonceBytes)
        let ciphertext = cipherAndTag.prefix(cipherAndTag.count - 16)
        let tag = cipherAndTag.suffix(16)
        let box = try AES.GCM.SealedBox(nonce: nonce, ciphertext: ciphertext, tag: tag)
        do {
            return try AES.GCM.open(box, using: key, authenticating: aad)
        } catch {
            throw VaultCryptoError.invalidEnvelope
        }
    }
}
