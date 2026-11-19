import CryptoKit
import Foundation

/// Encrypted on-disk snapshot for iOS AutoFill (`ASCredentialProviderViewController`).
/// Plaintext passwords never touch disk; only ciphertext manifests/chunks + public routing headers are stored.
public struct VaultAutoFillRecordSnapshot: Codable, Equatable, Sendable {
    public let objectIdBase64URL: String
    public let revision: UInt64
    public let manifestBase64URL: String
    public let chunksBase64URL: [String]
    public let hashesBase64URL: [String]

    public init(
        objectIdBase64URL: String,
        revision: UInt64,
        manifestBase64URL: String,
        chunksBase64URL: [String],
        hashesBase64URL: [String]
    ) {
        self.objectIdBase64URL = objectIdBase64URL
        self.revision = revision
        self.manifestBase64URL = manifestBase64URL
        self.chunksBase64URL = chunksBase64URL
        self.hashesBase64URL = hashesBase64URL
    }
}

public struct VaultAutoFillSnapshot: Codable, Equatable, Sendable {
    public let schemaVersion: Int
    public let context: VaultContext
    public let updatedAtEpochSeconds: Int64
    public let records: [VaultAutoFillRecordSnapshot]

    public init(
        context: VaultContext,
        updatedAtEpochSeconds: Int64 = Int64(Date().timeIntervalSince1970),
        records: [VaultAutoFillRecordSnapshot]
    ) {
        self.schemaVersion = 1
        self.context = context
        self.updatedAtEpochSeconds = updatedAtEpochSeconds
        self.records = records
    }
}

public struct VaultAutoFillCandidate: Equatable, Sendable {
    public let recordIdentifier: String
    public let title: String
    public let username: String
    public let domains: [String]
    public let hasTotp: Bool
}

public struct VaultAutoFillDecryptedCredential: Equatable, Sendable {
    public let recordIdentifier: String
    public let title: String
    public let username: String
    public let password: String
    public let totpCode: String?
}

public final class VaultAutoFillSnapshotStore: Sendable {
    private let fileURL: URL

    public init(fileURL: URL) {
        self.fileURL = fileURL
    }

    public func save(_ snapshot: VaultAutoFillSnapshot) throws {
        let dir = fileURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let data = try JSONEncoder().encode(snapshot)
        try data.write(to: fileURL, options: [.atomic, .completeFileProtection])
    }

    public func load() throws -> VaultAutoFillSnapshot? {
        guard FileManager.default.fileExists(atPath: fileURL.path) else {
            return nil
        }
        let data = try Data(contentsOf: fileURL)
        let snapshot = try JSONDecoder().decode(VaultAutoFillSnapshot.self, from: data)
        guard snapshot.schemaVersion == 1 else {
            throw VaultCryptoError.invalidManifest
        }
        return snapshot
    }

    public func clear() throws {
        if FileManager.default.fileExists(atPath: fileURL.path) {
            try FileManager.default.removeItem(at: fileURL)
        }
    }

    /// Lists credential candidates using manifest metadata only (never decrypts password chunks).
    public func listCandidates(
        rootKey: SymmetricKey,
        matchingHost: String? = nil
    ) throws -> [VaultAutoFillCandidate] {
        guard let snapshot = try load() else { return [] }
        let binding = Base64URL.encode(Data(SHA256.hash(data: try snapshot.context.contextInput())))
        var results: [VaultAutoFillCandidate] = []
        for record in snapshot.records {
            let object = try Base64URL.decode(record.objectIdBase64URL)
            let manifest = try Base64URL.decode(record.manifestBase64URL)
            let parsed = try VaultDocumentV3.readManifest(
                rootKey: rootKey,
                context: snapshot.context,
                object: object,
                revision: record.revision,
                manifestBytes: manifest
            )
            guard parsed.metadata.kind == .credential else { continue }
            if let matchingHost,
               !VaultCredentialCodec.matchesDomain(domains: parsed.metadata.domains, queryHost: matchingHost)
            {
                continue
            }
            results.append(
                VaultAutoFillCandidate(
                    recordIdentifier: binding + "." + record.objectIdBase64URL,
                    title: parsed.metadata.title,
                    username: parsed.metadata.username ?? "",
                    domains: parsed.metadata.domains ?? [],
                    hasTotp: parsed.metadata.hasTotp ?? false
                )
            )
        }
        return results
    }

    /// Decrypts a single requested credential on demand after biometric/user confirmation.
    public func decryptCredential(
        recordIdentifier: String,
        rootKey: SymmetricKey,
        now: Date = Date()
    ) throws -> VaultAutoFillDecryptedCredential? {
        guard let snapshot = try load() else { return nil }
        let prefix = Base64URL.encode(Data(SHA256.hash(data: try snapshot.context.contextInput()))) + "."
        guard recordIdentifier.hasPrefix(prefix) else { return nil }
        let objectID = String(recordIdentifier.dropFirst(prefix.count))
        guard let record = snapshot.records.first(where: { $0.objectIdBase64URL == objectID }) else { return nil }
        let object = try Base64URL.decode(record.objectIdBase64URL)
        let manifest = try Base64URL.decode(record.manifestBase64URL)
        let chunks = try record.chunksBase64URL.map(Base64URL.decode)
        let hashes = try record.hashesBase64URL.map(Base64URL.decode)
        let decrypted = try VaultDocumentV3.decrypt(
            rootKey: rootKey,
            context: snapshot.context,
            object: object,
            revision: record.revision,
            manifestBytes: manifest,
            chunks: chunks,
            hashes: hashes
        )
        let credential = VaultCredentialCodec.parse(decrypted.plaintext)
        let totpCode: String? = if !credential.totp.isEmpty {
            try? VaultTOTP.generate(input: credential.totp, now: now).code
        } else {
            nil
        }
        return VaultAutoFillDecryptedCredential(
            recordIdentifier: recordIdentifier,
            title: decrypted.metadata.title,
            username: credential.username,
            password: credential.password,
            totpCode: totpCode
        )
    }
}
