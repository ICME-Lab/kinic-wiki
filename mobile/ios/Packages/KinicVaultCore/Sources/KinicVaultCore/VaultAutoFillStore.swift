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

public struct VaultItemSummary: Equatable, Identifiable, Hashable, Sendable {
    public var id: String { objectIdBase64URL }
    public let objectIdBase64URL: String
    public let revision: UInt64
    public let kind: VaultDocumentKind
    public let title: String
    public let username: String
    public let domains: [String]
    public let hasTotp: Bool
    public let favorite: Bool
    public let tags: [String]
    public let filename: String?
    public let mime: String?

    public init(
        objectIdBase64URL: String,
        revision: UInt64,
        kind: VaultDocumentKind,
        title: String,
        username: String = "",
        domains: [String] = [],
        hasTotp: Bool = false,
        favorite: Bool = false,
        tags: [String] = [],
        filename: String? = nil,
        mime: String? = nil
    ) {
        self.objectIdBase64URL = objectIdBase64URL
        self.revision = revision
        self.kind = kind
        self.title = title
        self.username = username
        self.domains = domains
        self.hasTotp = hasTotp
        self.favorite = favorite
        self.tags = tags
        self.filename = filename
        self.mime = mime
    }

    public func matches(query: String) -> Bool {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return true }
        let lowered = trimmed.lowercased()
        if title.lowercased().contains(lowered)
            || username.lowercased().contains(lowered)
            || domains.contains(where: { $0.lowercased().contains(lowered) })
            || tags.contains(where: { $0.lowercased().contains(lowered) })
            || (filename?.lowercased().contains(lowered) ?? false)
        {
            return true
        }
        return VaultCredentialCodec.matchesDomain(domains: domains, queryHost: trimmed)
    }
}

public struct VaultDecryptedItem: Equatable, Sendable {
    public let summary: VaultItemSummary
    public let credential: VaultCredentialRecord?
    public let noteText: String?
    public let plaintextLength: Int

    public init(
        summary: VaultItemSummary,
        credential: VaultCredentialRecord? = nil,
        noteText: String? = nil,
        plaintextLength: Int
    ) {
        self.summary = summary
        self.credential = credential
        self.noteText = noteText
        self.plaintextLength = plaintextLength
    }
}

extension VaultAutoFillSnapshot {
    public func listItems(rootKey: SymmetricKey) throws -> [VaultItemSummary] {
        var results: [VaultItemSummary] = []
        results.reserveCapacity(records.count)
        for record in records {
            let object = try Base64URL.decode(record.objectIdBase64URL)
            let manifest = try Base64URL.decode(record.manifestBase64URL)
            let parsed = try VaultDocumentV3.readManifest(
                rootKey: rootKey,
                context: context,
                object: object,
                revision: record.revision,
                manifestBytes: manifest
            )
            results.append(
                VaultItemSummary(
                    objectIdBase64URL: record.objectIdBase64URL,
                    revision: record.revision,
                    kind: parsed.metadata.kind,
                    title: parsed.metadata.title,
                    username: parsed.metadata.username ?? "",
                    domains: parsed.metadata.domains ?? [],
                    hasTotp: parsed.metadata.hasTotp ?? false,
                    favorite: parsed.metadata.favorite ?? false,
                    tags: parsed.metadata.tags ?? [],
                    filename: parsed.metadata.filename,
                    mime: parsed.metadata.mime
                )
            )
        }
        return results
    }

    public func decryptItem(
        objectIdBase64URL: String,
        rootKey: SymmetricKey
    ) throws -> VaultDecryptedItem? {
        guard let record = records.first(where: { $0.objectIdBase64URL == objectIdBase64URL }) else {
            return nil
        }
        let object = try Base64URL.decode(record.objectIdBase64URL)
        let manifest = try Base64URL.decode(record.manifestBase64URL)
        let chunks = try record.chunksBase64URL.map(Base64URL.decode)
        let hashes = try record.hashesBase64URL.map(Base64URL.decode)
        let decrypted = try VaultDocumentV3.decrypt(
            rootKey: rootKey,
            context: context,
            object: object,
            revision: record.revision,
            manifestBytes: manifest,
            chunks: chunks,
            hashes: hashes
        )
        let meta = decrypted.metadata
        let summary = VaultItemSummary(
            objectIdBase64URL: record.objectIdBase64URL,
            revision: record.revision,
            kind: meta.kind,
            title: meta.title,
            username: meta.username ?? "",
            domains: meta.domains ?? [],
            hasTotp: meta.hasTotp ?? false,
            favorite: meta.favorite ?? false,
            tags: meta.tags ?? [],
            filename: meta.filename,
            mime: meta.mime
        )
        switch meta.kind {
        case .credential:
            return VaultDecryptedItem(
                summary: summary,
                credential: VaultCredentialCodec.parse(decrypted.plaintext),
                noteText: nil,
                plaintextLength: decrypted.plaintext.count
            )
        case .note:
            return VaultDecryptedItem(
                summary: summary,
                credential: nil,
                noteText: String(data: decrypted.plaintext, encoding: .utf8) ?? "",
                plaintextLength: decrypted.plaintext.count
            )
        case .attachment:
            return VaultDecryptedItem(
                summary: summary,
                credential: nil,
                noteText: nil,
                plaintextLength: decrypted.plaintext.count
            )
        }
    }

    public func upsertingRecord(
        _ record: VaultAutoFillRecordSnapshot,
        updatedAtEpochSeconds: Int64 = Int64(Date().timeIntervalSince1970)
    ) -> VaultAutoFillSnapshot {
        var next = records
        if let index = next.firstIndex(where: { $0.objectIdBase64URL == record.objectIdBase64URL }) {
            next[index] = record
        } else {
            next.append(record)
        }
        return VaultAutoFillSnapshot(
            context: context,
            updatedAtEpochSeconds: updatedAtEpochSeconds,
            records: next
        )
    }

    public func removingRecord(
        objectIdBase64URL: String,
        updatedAtEpochSeconds: Int64 = Int64(Date().timeIntervalSince1970)
    ) -> VaultAutoFillSnapshot {
        VaultAutoFillSnapshot(
            context: context,
            updatedAtEpochSeconds: updatedAtEpochSeconds,
            records: records.filter { $0.objectIdBase64URL != objectIdBase64URL }
        )
    }
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

    /// Reads only credential bodies and returns a candidate for each account.
    public func listCandidates(
        rootKey: SymmetricKey,
        matchingHost: String? = nil
    ) throws -> [VaultAutoFillCandidate] {
        guard let snapshot = try load() else { return [] }
        let binding = try Self.recordBinding(snapshot.context)
        var results: [VaultAutoFillCandidate] = []
        for summary in try snapshot.listItems(rootKey: rootKey) where summary.kind == .credential {
            guard let credential = try snapshot.decryptItem(objectIdBase64URL: summary.objectIdBase64URL, rootKey: rootKey)?.credential else {
                continue
            }
            for (index, login) in Self.logins(credential, legacyDomains: summary.domains).enumerated() {
                if let matchingHost,
                   !VaultCredentialCodec.matchesDomain(domains: login.domains, queryHost: matchingHost) {
                    continue
                }
                guard !login.password.isEmpty else { continue }
                results.append(VaultAutoFillCandidate(
                    recordIdentifier: "\(binding).\(summary.objectIdBase64URL).\(summary.revision).\(index)",
                    title: summary.title,
                    username: login.username,
                    domains: login.domains,
                    hasTotp: !login.totp.isEmpty
                ))
            }
        }
        return results
    }

    /// Rechecks the selected account and revision after device authentication.
    public func decryptCredential(
        recordIdentifier: String,
        rootKey: SymmetricKey,
        matchingHosts: [String] = [],
        now: Date = Date()
    ) throws -> VaultAutoFillDecryptedCredential? {
        guard let snapshot = try load() else { return nil }
        let parts = recordIdentifier.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4, parts[0] == (try Self.recordBinding(snapshot.context)),
              let revision = UInt64(parts[2]), let index = Int(parts[3]), index >= 0,
              let record = snapshot.records.first(where: { $0.objectIdBase64URL == parts[1] }),
              record.revision == revision,
              let item = try snapshot.decryptItem(objectIdBase64URL: record.objectIdBase64URL, rootKey: rootKey),
              let credential = item.credential else { return nil }
        let logins = Self.logins(credential, legacyDomains: item.summary.domains)
        guard logins.indices.contains(index) else { return nil }
        let login = logins[index]
        guard !login.password.isEmpty, matchingHosts.isEmpty || matchingHosts.contains(where: {
            VaultCredentialCodec.matchesDomain(domains: login.domains, queryHost: $0)
        }) else { return nil }
        let code = login.totp.isEmpty ? nil : try? VaultTOTP.generate(input: login.totp, now: now).code
        return VaultAutoFillDecryptedCredential(
            recordIdentifier: recordIdentifier,
            title: item.summary.title,
            username: login.username,
            password: login.password,
            totpCode: code
        )
    }

    private static func recordBinding(_ context: VaultContext) throws -> String {
        Base64URL.encode(Data(SHA256.hash(data: try context.contextInput())))
    }

    private struct Login {
        let username: String
        let password: String
        let domains: [String]
        let totp: String
    }

    private static func logins(_ credential: VaultCredentialRecord, legacyDomains: [String]) -> [Login] {
        let primaryDomains = VaultCredentialCodec.extractDomains([credential.url] + credential.urls)
        let domains = primaryDomains.isEmpty && credential.additionalLogins.isEmpty ? legacyDomains : primaryDomains
        return [Login(username: credential.username, password: credential.password, domains: domains, totp: credential.totp)]
            + credential.additionalLogins.map {
                Login(username: $0.username, password: $0.password, domains: VaultCredentialCodec.extractDomains([$0.url]), totp: "")
            }
    }

    /// Lists all Vault item summaries from manifest metadata without decrypting chunk plaintext.
    public func listItems(rootKey: SymmetricKey) throws -> [VaultItemSummary] {
        guard let snapshot = try load() else { return [] }
        return try snapshot.listItems(rootKey: rootKey)
    }

    /// Decrypts a single item (credential or note) on demand.
    public func decryptItem(
        objectIdBase64URL: String,
        rootKey: SymmetricKey
    ) throws -> VaultDecryptedItem? {
        guard let snapshot = try load() else { return nil }
        return try snapshot.decryptItem(objectIdBase64URL: objectIdBase64URL, rootKey: rootKey)
    }
}
