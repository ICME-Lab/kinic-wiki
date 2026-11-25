import CryptoKit
import Foundation
import Testing
@testable import KinicVaultCore

@Suite("KinicVaultCore cross-platform protocol & AutoFill tests")
struct KinicVaultCoreTests {
    // Generated directly by packages/vault-crypto (TypeScript WebCrypto) to guarantee byte-for-byte interop.
    private static let tsContextInputB64 =
        "AAAACgAAAAAAAAABAQEAAAAKAAAAAAAAAAEBAQAAABABAQEBAQEBAQEBAQEBAQEBAAAAIAICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAAAACnRlc3Rfa2V5XzE"
    private static let tsDekAadB64 =
        "AAAAF2tpbmljLXZhdWx0L2RvY3VtZW50L3YzAAAAYgAAAAoAAAAAAAAAAQEBAAAACgAAAAAAAAABAQEAAAAQAQEBAQEBAQEBAQEBAQEBAQAAACACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgAAAAp0ZXN0X2tleV8xAAAAEAQEBAQEBAQEBAQEBAQEBAQAAAAIAAAAAAAAAAEAAAADZGVrAAAABAAAAAA"
    private static let tsManifestB64 =
        "eyJ2ZXJzaW9uIjozLCJkZWsiOnsidmVyc2lvbiI6Mywibm9uY2UiOiJOZzNnZWgtTzFfU2ZSYTJnIiwiY2lwaGVydGV4dCI6IlFya2FxeXFjXzJ5NWc1RzV1NHVNZ2FsMkl6MEF1U3daeDVpZmpsN09oT0NfOGh0bXRZQjFCeEpnUjBJc1hWZDkifSwibWV0YWRhdGEiOnsidmVyc2lvbiI6Mywibm9uY2UiOiJlTlJZb0dnVzVzMVFsdzF1IiwiY2lwaGVydGV4dCI6InpLdDF1WlV4WVhkbko3M1lCZTVjRTR3OUtqYV9kc25NcEsxa2dhb3dKS0dwdmpUWVp0QXV6UnlTNnJhZm1ta3Exc1h4Z3daT3d6VmlONXgxNHpCbnlHWjFISVVNc294OGhRdXNob3ctLVh4ZU8wTmlEanZUYTZVWnZiU1I5ZmVfYW5pSXpPQXRzeEtwSWFyUDRLQTNfRnR2R0FqSVY4NElLcGRuZFNYWWhDVlltVlpjRXdKR2ZIbk45YmhmSzRrUkVRSlFDQ20yM0UzajVTZ25nN1VDTk1hRVRsRXFaNTEzeFJEdDFtVjNEMTBvMzVDaUNpWm40bFc4bW1ZZmxLbHFILUJHN2tSQko0ZU16UFg0OUJDQnNQX1hqM2JnWlUyS0hyaWM3Z1VOc3NsTU1wa1paVmt0WFlZIn0sIm5vbmNlcyI6WyJORG0xcEFLM3EyNTVPZ1BPIl19"
    private static let tsChunk0B64 =
        "WJ1v_0Ew-qlTQ-mILVdkdD-nRnuzTLogdQQM-gLI6op3ODFJJAINQTieB74m4QRK_dFVABXYBWRnD4iLjwaOudeEslaFauq_cAkgoMpinjstAtTlFMOfvkZAx8VP7YMCvN3Ip8W4ZrtxD6EF-NOHRbNQfDJPcyQ5oV_274HOiFNexpGA51tpCzBhfGToRTjTbAXEP-E_ifuto5jmcB8d6l7TeYw54KWr5eKAiRL3pHrrACEHI5EFp7p21cWQR2VfTYlT1x2FYoPgINLUjSMuhnq1lEPPRWlLUy2fZR4KlQoGeMtbicnNuL0aWg8NRpIoKpVm10tVse6OYMO4vpohFAat2ed2Z7XB0LmT6n72Q7PWVmCh3JN5EsmsEA"
    private static let tsHash0B64 =
        "uiw5pku9sI0SwAGVBHsw1BLEb2SrOt7lbNV9yGKZnU0"

    private func makeTestContext() throws -> VaultContext {
        try VaultContext(
            canister: "rrkah-fqaaa-aaaaa-aaaaq-cai",
            owner: "rrkah-fqaaa-aaaaa-aaaaq-cai",
            vault: Data(repeating: 1, count: 16),
            nonce: Data(repeating: 2, count: 32),
            keyName: "test_key_1"
        )
    }

    @Test func metadataUsesTheWebUTF16Limits() throws {
        let emoji = "🗝"
        let longTag = String(repeating: emoji, count: 40)
        let record = VaultCredentialRecord(username: String(repeating: emoji, count: 150), tags: [longTag])
        let metadata = VaultCredentialCodec.buildMetadata(title: String(repeating: emoji, count: 300), record: record)
        #expect(metadata.title.utf16.count == 512)
        #expect(metadata.username?.utf16.count == 256)
        #expect(metadata.tags?.first?.utf16.count == 64)
        try metadata.validate()
        #expect(throws: VaultCryptoError.invalidMetadata) {
            try VaultMetadata(kind: .note, title: "Test", tags: [longTag]).validate()
        }
    }

    @Test func findsLegacyWebCredentialsByDomain() throws {
        let context = try makeTestContext()
        let key = SymmetricKey(size: .bits256)
        let object = Data(repeating: 4, count: 16)
        let payload = Data(#"{"username":"alice","password":"test","URL":"https://example.com/login"}"#.utf8)
        let encrypted = try VaultDocumentV3.encrypt(
            rootKey: key, context: context, object: object, revision: 1,
            metadata: VaultMetadata(kind: .credential, title: "Legacy"), plaintext: payload
        )
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let store = VaultAutoFillSnapshotStore(fileURL: file)
        defer { try? store.clear() }
        let record = VaultAutoFillRecordSnapshot(
            objectIdBase64URL: Base64URL.encode(object), revision: 1,
            manifestBase64URL: Base64URL.encode(encrypted.manifest),
            chunksBase64URL: encrypted.chunks.map(Base64URL.encode), hashesBase64URL: encrypted.hashes.map(Base64URL.encode)
        )
        try store.save(VaultAutoFillSnapshot(context: context, records: [record]))

        let candidate = try #require(store.listCandidates(rootKey: key, matchingHost: "example.com").first)
        #expect(candidate.domains == ["example.com"])
        #expect(candidate.username == "alice")
        #expect(try store.decryptCredential(recordIdentifier: candidate.recordIdentifier, rootKey: key)?.password == "test")
    }

    @Test("Decrypts real TypeScript v3 encrypted credential byte-for-byte")
    func decryptsTypeScriptV3Vector() throws {
        let context = try makeTestContext()
        let object = Data(repeating: 4, count: 16)
        let rootKey = SymmetricKey(data: Data(repeating: 9, count: 32))

        #expect(Base64URL.encode(try context.contextInput()) == Self.tsContextInputB64)
        #expect(
            Base64URL.encode(try context.documentAAD(object: object, revision: 1, usage: .dek))
                == Self.tsDekAadB64
        )

        let manifest = try Base64URL.decode(Self.tsManifestB64)
        let chunk0 = try Base64URL.decode(Self.tsChunk0B64)
        let hash0 = try Base64URL.decode(Self.tsHash0B64)

        let decrypted = try VaultDocumentV3.decrypt(
            rootKey: rootKey,
            context: context,
            object: object,
            revision: 1,
            manifestBytes: manifest,
            chunks: [chunk0],
            hashes: [hash0]
        )

        #expect(decrypted.metadata.kind == .credential)
        #expect(decrypted.metadata.title == "GitHub")
        #expect(decrypted.metadata.username == "alice@example.com")
        #expect(decrypted.metadata.domains == ["github.com", "gist.github.com"])
        #expect(decrypted.metadata.hasTotp == true)
        #expect(decrypted.metadata.favorite == true)
        #expect(decrypted.metadata.tags == ["work", "dev"])

        let cred = VaultCredentialCodec.parse(decrypted.plaintext)
        #expect(cred.username == "alice@example.com")
        #expect(cred.password == "S3cur3!Password")
        #expect(cred.totp == "JBSWY3DPEHPK3PXP")
        #expect(cred.notes == "Backup codes stored")
    }

    @Test("Round-trips Swift v3 encryption and rejects tampered chunks or swapped context")
    func roundTripsSwiftV3Encryption() throws {
        let context = try makeTestContext()
        let object = Data(repeating: 7, count: 16)
        let rootKey = SymmetricKey(data: Data(repeating: 5, count: 32))
        let record = VaultCredentialRecord(
            label: "Linear",
            username: "dev@example.com",
            password: "generated-password",
            url: "https://linear.app/login",
            urls: ["https://linear.app/login"],
            totp: "JBSWY3DPEHPK3PXP",
            notes: "Team SSO fallback",
            favorite: true,
            tags: ["work"]
        )
        let meta = VaultCredentialCodec.buildMetadata(title: "Linear", record: record)
        let plain = try VaultCredentialCodec.serialize(record)
        let encrypted = try VaultDocumentV3.encrypt(
            rootKey: rootKey,
            context: context,
            object: object,
            revision: 2,
            metadata: meta,
            plaintext: plain
        )

        let decrypted = try VaultDocumentV3.decrypt(
            rootKey: rootKey,
            context: context,
            object: object,
            revision: 2,
            manifestBytes: encrypted.manifest,
            chunks: encrypted.chunks,
            hashes: encrypted.hashes
        )
        #expect(decrypted.metadata == meta)
        #expect(VaultCredentialCodec.parse(decrypted.plaintext).password == "generated-password")

        var tampered = encrypted.chunks
        tampered[0][0] ^= 0xff
        #expect(throws: VaultCryptoError.corruptChunk) {
            _ = try VaultDocumentV3.decrypt(
                rootKey: rootKey,
                context: context,
                object: object,
                revision: 2,
                manifestBytes: encrypted.manifest,
                chunks: tampered,
                hashes: encrypted.hashes
            )
        }
    }

    @Test("Matches RFC 6238 TOTP vectors across SHA-1, SHA-256, and SHA-512")
    func matchesRFC6238TotpVectors() throws {
        let sha1Seed = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
        let sha256Seed = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA===="
        let sha512Seed =
            "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNA="

        let sha1 = try VaultTOTP.generate(
            config: VaultTOTPConfig(secret: sha1Seed, algorithm: .sha1, digits: 8, period: 30),
            now: Date(timeIntervalSince1970: 59)
        )
        #expect(sha1.code == "94287082")
        #expect(sha1.remainingSeconds == 1)

        let sha256 = try VaultTOTP.generate(
            config: VaultTOTPConfig(secret: sha256Seed, algorithm: .sha256, digits: 8, period: 30),
            now: Date(timeIntervalSince1970: 1_111_111_109)
        )
        #expect(sha256.code == "68084774")

        let sha512 = try VaultTOTP.generate(
            config: VaultTOTPConfig(secret: sha512Seed, algorithm: .sha512, digits: 8, period: 30),
            now: Date(timeIntervalSince1970: 1_234_567_890)
        )
        #expect(sha512.code == "93441116")

        let parsed = try VaultTOTP.parse("otpauth://totp/GitHub:alice?secret=\(sha1Seed)&issuer=GitHub")
        #expect(parsed.issuer == "GitHub")
        #expect(parsed.digits == 6)
    }

    @Test("AutoFill encrypted snapshot store indexes domains without plaintext on disk and decrypts on demand")
    func autoFillSnapshotStoreRoundTrip() throws {
        let context = try makeTestContext()
        let rootKey = SymmetricKey(data: Data(repeating: 9, count: 32))
        let object = Data(repeating: 4, count: 16)
        let objectId = Base64URL.encode(object)

        let tempURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("kinic-vault-autofill-test-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: tempURL) }

        let store = VaultAutoFillSnapshotStore(fileURL: tempURL)
        let snapshot = VaultAutoFillSnapshot(
            context: context,
            records: [
                VaultAutoFillRecordSnapshot(
                    objectIdBase64URL: objectId,
                    revision: 1,
                    manifestBase64URL: Self.tsManifestB64,
                    chunksBase64URL: [Self.tsChunk0B64],
                    hashesBase64URL: [Self.tsHash0B64]
                ),
            ]
        )
        try store.save(snapshot)

        // Confirm password plaintext never appears on disk.
        let diskText = try String(contentsOf: tempURL, encoding: .utf8)
        #expect(!diskText.contains("S3cur3!Password"))
        #expect(!diskText.contains("alice@example.com"))

        // Domain matching via manifest metadata only.
        let matched = try store.listCandidates(rootKey: rootKey, matchingHost: "api.github.com")
        #expect(matched.count == 1)
        #expect(matched[0].recordIdentifier != objectId)
        #expect(try store.decryptCredential(recordIdentifier: objectId, rootKey: rootKey) == nil)
        #expect(matched[0].title == "GitHub")
        #expect(matched[0].username == "alice@example.com")
        #expect(matched[0].hasTotp == true)

        let unmatched = try store.listCandidates(rootKey: rootKey, matchingHost: "example.org")
        #expect(unmatched.isEmpty)

        // On-demand decryption returns password + live TOTP code.
        let decrypted = try store.decryptCredential(
            recordIdentifier: matched[0].recordIdentifier,
            rootKey: rootKey,
            now: Date(timeIntervalSince1970: 59)
        )
        #expect(decrypted?.username == "alice@example.com")
        #expect(decrypted?.password == "S3cur3!Password")
        #expect(decrypted?.totpCode?.count == 6)
    }

    @Test("Generates unbiased strong passwords honoring options")
    func generatesStrongPasswords() throws {
        let pw = try VaultPasswordGenerator.generate(
            VaultPasswordOptions(length: 24, excludeAmbiguous: true)
        )
        #expect(pw.count == 24)
        #expect(!pw.contains("0"))
        #expect(!pw.contains("O"))
        #expect(!pw.contains("1"))
        #expect(!pw.contains("l"))
        #expect(!pw.contains("I"))
    }
    @Test("Rejects duplicate known TOTP parameters instead of trapping")
    func rejectsAmbiguousTotpUris() throws {
        let uri = "otpauth://totp/Test?secret=JBSWY3DPEHPK3PXP"
        for suffix in ["&secret=JBSWY3DPEHPK3PXP", "&SECRET=JBSWY3DPEHPK3PXP", "&issuer=A&ISSUER=B"] {
            #expect(throws: VaultCryptoError.invalidTotpUri) { _ = try VaultTOTP.parse(uri + suffix) }
        }
        #expect(try VaultTOTP.parse(uri + "&extra=one&extra=two").secret == "JBSWY3DPEHPK3PXP")
    }

    @Test("Rejects malformed numeric parameters and direct invalid configurations")
    func rejectsInvalidTotpNumbers() throws {
        let uri = "otpauth://totp/Test?secret=JBSWY3DPEHPK3PXP"
        for suffix in ["&digits=", "&digits=abc", "&period=", "&period=abc"] {
            #expect(throws: (any Error).self) { _ = try VaultTOTP.parse(uri + suffix) }
        }
        #expect(throws: VaultCryptoError.invalidTotpPeriod) {
            _ = try VaultTOTP.generate(config: VaultTOTPConfig(secret: "JBSWY3DPEHPK3PXP", period: 0))
        }
        #expect(throws: VaultCryptoError.invalidTotpDigits) {
            _ = try VaultTOTP.generate(config: VaultTOTPConfig(secret: "JBSWY3DPEHPK3PXP", digits: 99))
        }
    }

    @Test("Malformed TOTP does not prevent filling the saved password")
    func fillsPasswordWithInvalidTotp() throws {
        let context = try makeTestContext()
        let key = SymmetricKey(data: Data(repeating: 9, count: 32))
        let object = Data(repeating: 6, count: 16)
        let record = VaultCredentialRecord(username: "alice", password: "keep-password", totp: "otpauth://totp/X?secret=JBSWY3DPEHPK3PXP&SECRET=duplicate")
        let encrypted = try VaultDocumentV3.encrypt(rootKey: key, context: context, object: object, revision: 1, metadata: VaultCredentialCodec.buildMetadata(title: "Login", record: record), plaintext: VaultCredentialCodec.serialize(record))
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: url) }
        let store = VaultAutoFillSnapshotStore(fileURL: url)
        try store.save(VaultAutoFillSnapshot(context: context, records: [VaultAutoFillRecordSnapshot(objectIdBase64URL: Base64URL.encode(object), revision: 1, manifestBase64URL: Base64URL.encode(encrypted.manifest), chunksBase64URL: encrypted.chunks.map(Base64URL.encode), hashesBase64URL: encrypted.hashes.map(Base64URL.encode))]))
        let candidate = try #require(store.listCandidates(rootKey: key).first)
        let filled = try store.decryptCredential(recordIdentifier: candidate.recordIdentifier, rootKey: key)
        #expect(filled?.username == "alice")
        #expect(filled?.password == "keep-password")
        #expect(filled?.totpCode == nil)
    }

    @Test("Generates passphrases and measures strength consistently with Web")
    func passphraseGenerationAndStrength() throws {
        let phrase = try VaultPasswordGenerator.generatePassphrase(
            VaultPassphraseOptions(words: 5, separator: "-", capitalize: true, includeNumber: true)
        )
        let parts = phrase.split(separator: "-")
        #expect(parts.count == 5)
        let generatorStrength = VaultPasswordGenerator.estimatePassphraseStrength(
            VaultPassphraseOptions(words: 5, separator: "-", capitalize: true, includeNumber: true)
        )
        let recognizedStrength = VaultPasswordGenerator.estimateStrength(phrase)
        #expect(recognizedStrength.level == generatorStrength.level)
        #expect(abs(recognizedStrength.entropyBits - generatorStrength.entropyBits) < 0.001)

        // Short password is always weak regardless of character diversity.
        #expect(VaultPasswordGenerator.estimateStrength("Ab1!x").level == .weak)
        // Formatting choice (capitalization / separator) does not inflate passphrase entropy.
        let lowerStrength = VaultPasswordGenerator.estimatePassphraseStrength(
            VaultPassphraseOptions(words: 4, separator: "-", capitalize: false, includeNumber: false)
        )
        let capStrength = VaultPasswordGenerator.estimatePassphraseStrength(
            VaultPassphraseOptions(words: 4, separator: ".", capitalize: true, includeNumber: false)
        )
        #expect(lowerStrength == capStrength)
        #expect(lowerStrength.level == .fair) // 4 * 11 = 44 bits
        // The default passphrase (5 words + number) is strong: 55 + log2(500) ≈ 64 bits.
        #expect(VaultPasswordGenerator.estimatePassphraseStrength(VaultPassphraseOptions()).level == .strong)
    }

    @Test("Uses the same BIP-39 English wordlist as packages/vault-crypto")
    func passphraseWordlistMatchesWeb() {
        let words = VaultPassphraseWordlist.words
        #expect(words.count == 2048)
        #expect(Set(words).count == 2048)
        let digest = SHA256.hash(data: Data(words.joined(separator: "\n").utf8))
        let hex = digest.map { String(format: "%02x", $0) }.joined()
        // Same digest is asserted in packages/vault-crypto/test/password-generator.test.ts.
        #expect(hex == "187db04a869dd9bc7be80d21a86497d692c0db6abd3aa8cb6be5d618ff757fae")
    }

    @Test("Formats TOTP codes cleanly for 6-digit and 8-digit displays")
    func formatsTotpCodes() {
        #expect(VaultTOTP.formatCode("123456") == "123 456")
        #expect(VaultTOTP.formatCode("94287082") == "9428 7082")
        #expect(VaultTOTP.formatCode("12345") == "12345")
    }

    @Test("Matches subdomains one-way and blocks public suffix parent wildcards")
    func matchesDomainStrictRules() {
        #expect(VaultCredentialCodec.matchesDomain(domains: ["github.com"], queryHost: "https://api.github.com/v1"))
        #expect(VaultCredentialCodec.matchesDomain(domains: ["github.com"], queryHost: "https://github.com"))
        #expect(!VaultCredentialCodec.matchesDomain(domains: ["github.com"], queryHost: "https://notgithub.com"))
        // Stored subdomain must not match its parent domain or sibling subdomains.
        #expect(!VaultCredentialCodec.matchesDomain(domains: ["accounts.example.com"], queryHost: "https://example.com"))
        #expect(!VaultCredentialCodec.matchesDomain(domains: ["accounts.example.com"], queryHost: "https://mail.example.com"))
        #expect(VaultCredentialCodec.matchesDomain(domains: ["accounts.example.com"], queryHost: "https://accounts.example.com"))
        // Public suffixes and shared multi-tenant hosts must not act as wildcard parents.
        #expect(!VaultCredentialCodec.matchesDomain(domains: ["co.uk"], queryHost: "https://bank.co.uk"))
        #expect(!VaultCredentialCodec.matchesDomain(domains: ["github.io"], queryHost: "https://victim.github.io"))
        #expect(!VaultCredentialCodec.matchesDomain(domains: ["icp0.io"], queryHost: "https://canister.icp0.io"))
    }

    @Test("Snapshot lists both credentials and notes while AutoFill candidates stay credential-only")
    func snapshotListsRichItemsAndPreservesAutoFillFilter() throws {
        let context = try makeTestContext()
        let key = SymmetricKey(data: Data(repeating: 9, count: 32))

        let credObject = Data(repeating: 10, count: 16)
        let credRecord = VaultCredentialRecord(
            label: "GitHub",
            username: "alice@example.com",
            password: "super-secret-password",
            url: "https://github.com/login",
            urls: ["https://github.com/login", "https://gist.github.com"],
            totp: "JBSWY3DPEHPK3PXP",
            notes: "Work account",
            customFields: [VaultCustomField(label: "Recovery PIN", value: "9988", hidden: true)],
            favorite: true,
            tags: ["work", "dev"]
        )
        let credMeta = VaultCredentialCodec.buildMetadata(title: "GitHub", record: credRecord)
        let credEncrypted = try VaultDocumentV3.encrypt(
            rootKey: key,
            context: context,
            object: credObject,
            revision: 1,
            metadata: credMeta,
            plaintext: try VaultCredentialCodec.serialize(credRecord)
        )

        let noteObject = Data(repeating: 11, count: 16)
        let noteMeta = VaultMetadata(kind: .note, title: "SSH Backup", favorite: true, tags: ["ops"])
        let noteEncrypted = try VaultDocumentV3.encrypt(
            rootKey: key,
            context: context,
            object: noteObject,
            revision: 1,
            metadata: noteMeta,
            plaintext: Data("backup key instructions".utf8)
        )

        let url = FileManager.default.temporaryDirectory.appendingPathComponent("vault-items-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: url) }
        let store = VaultAutoFillSnapshotStore(fileURL: url)
        let snapshot = VaultAutoFillSnapshot(
            context: context,
            records: [
                VaultAutoFillRecordSnapshot(
                    objectIdBase64URL: Base64URL.encode(credObject),
                    revision: 1,
                    manifestBase64URL: Base64URL.encode(credEncrypted.manifest),
                    chunksBase64URL: credEncrypted.chunks.map(Base64URL.encode),
                    hashesBase64URL: credEncrypted.hashes.map(Base64URL.encode)
                ),
                VaultAutoFillRecordSnapshot(
                    objectIdBase64URL: Base64URL.encode(noteObject),
                    revision: 1,
                    manifestBase64URL: Base64URL.encode(noteEncrypted.manifest),
                    chunksBase64URL: noteEncrypted.chunks.map(Base64URL.encode),
                    hashesBase64URL: noteEncrypted.hashes.map(Base64URL.encode)
                ),
            ]
        )
        try store.save(snapshot)

        let items = try store.listItems(rootKey: key)
        #expect(items.count == 2)
        #expect(items.first(where: { $0.kind == .credential })?.favorite == true)
        #expect(items.first(where: { $0.kind == .credential })?.matches(query: "gist.github.com") == true)
        #expect(items.first(where: { $0.kind == .note })?.matches(query: "ops") == true)

        // AutoFill candidates remain strictly credential-only.
        let candidates = try store.listCandidates(rootKey: key)
        #expect(candidates.count == 1)
        #expect(candidates[0].title == "GitHub")

        let decryptedCred = try store.decryptItem(objectIdBase64URL: Base64URL.encode(credObject), rootKey: key)
        #expect(decryptedCred?.credential?.customFields == [VaultCustomField(label: "Recovery PIN", value: "9988", hidden: true)])
        #expect(decryptedCred?.credential?.urls == ["https://github.com/login", "https://gist.github.com"])

        let decryptedNote = try store.decryptItem(objectIdBase64URL: Base64URL.encode(noteObject), rootKey: key)
        #expect(decryptedNote?.noteText == "backup key instructions")

        let removed = snapshot.removingRecord(objectIdBase64URL: Base64URL.encode(noteObject))
        #expect(try removed.listItems(rootKey: key).count == 1)
    }

}
