import CryptoKit
import Foundation
import ICNativeClient
import KinicVaultCore
import Security

public enum VaultNativeError: Error, LocalizedError, Equatable {
    case invalidResponse
    case rejected
    case notFound
    case accessLost
    case changedDuringSync
    case snapshotTooLarge
    case providerDisabled
    case cleanupFailed
    case conflict
    case quotaExceeded
    case invalidInput
    case busy

    public var errorDescription: String? {
        switch self {
        case .providerDisabled: "Enable Kinic Vault in iOS AutoFill settings, then return and sync again."
        case .cleanupFailed: "Offline Vault cleanup is incomplete. Try disabling again."
        case .notFound: "The requested Vault item was not found."
        case .invalidResponse: "The Vault response was invalid."
        case .accessLost: "Access to this Vault was lost. Its offline cache has been removed."
        case .rejected: "The Vault rejected this request. Check access and local operating credit."
        case .changedDuringSync: "The Vault changed during synchronization. Try again."
        case .snapshotTooLarge: "This Vault exceeds the offline AutoFill cache limit."
        case .conflict: "This item changed on another device. Sync and try again."
        case .quotaExceeded: "This Vault reached its storage or operating credit limit."
        case .invalidInput: "The submitted Vault data was rejected as invalid."
        case .busy: "The Vault is busy processing another operation. Try again."
        }
    }
}

public struct VaultNativeSavedRecord: Sendable {
    public let snapshotRecord: VaultAutoFillRecordSnapshot
    public let rootKey: SymmetricKey
    public let context: VaultContext
    public let revision: UInt64
    public let sequence: UInt64

    public init(
        snapshotRecord: VaultAutoFillRecordSnapshot,
        rootKey: SymmetricKey,
        context: VaultContext,
        revision: UInt64,
        sequence: UInt64
    ) {
        self.snapshotRecord = snapshotRecord
        self.rootKey = rootKey
        self.context = context
        self.revision = revision
        self.sequence = sequence
    }
}

enum VaultWire {
    static func unwrap(_ value: CandidValue) throws -> CandidValue {
        guard case .variant(let result) = value else { throw VaultNativeError.invalidResponse }
        guard result.tag == Candid.fieldID("Ok") else {
            if case .variant(let error) = result.value {
                if ["Unauthorized", "VaultInactive"].contains(where: { Candid.fieldID($0) == error.tag }) {
                    throw VaultNativeError.accessLost
                }
                if error.tag == Candid.fieldID("NotFound") {
                    throw VaultNativeError.notFound
                }
                if error.tag == Candid.fieldID("Conflict") {
                    throw VaultNativeError.conflict
                }
                if error.tag == Candid.fieldID("QuotaExceeded") {
                    throw VaultNativeError.quotaExceeded
                }
                if error.tag == Candid.fieldID("InvalidInput") {
                    throw VaultNativeError.invalidInput
                }
                if error.tag == Candid.fieldID("Busy") {
                    throw VaultNativeError.busy
                }
            }
            throw VaultNativeError.rejected
        }
        return result.value
    }

    /// A missing revision may be a concurrent purge, rather than lost Vault access.
    static func readSnapshotObject<T: Sendable>(
        isolation: isolated (any Actor)? = #isolation,
        read: () async throws -> T,
        revalidate: () async throws -> Void
    ) async throws -> T {
        do { return try await read() }
        catch VaultNativeError.notFound {
            try await revalidate()
            throw VaultNativeError.changedDuringSync
        }
    }

    static func field<T: CandidConvertible>(_ name: String, _ value: CandidValue, as: T.Type = T.self) throws -> T {
        guard case .record(_, let values) = value, let field = values[Candid.fieldID(name)] else {
            throw VaultNativeError.invalidResponse
        }
        return try T(candidValue: field)
    }

    static func rawField(_ name: String, _ value: CandidValue) throws -> CandidValue {
        guard case .record(_, let values) = value, let field = values[Candid.fieldID(name)] else {
            throw VaultNativeError.invalidResponse
        }
        return field
    }

    static func array(_ value: CandidValue) throws -> [CandidValue] {
        guard case .vector(_, let values) = value else { throw VaultNativeError.invalidResponse }
        return values
    }

    static func arguments(_ values: CandidTypedValue...) -> CandidArguments { CandidArguments(values) }

    static func bytesRecord(_ entries: [(String, Data)]) throws -> CandidArguments {
        let fields = entries.map { CandidField($0.0, type: .vector(.nat8)) }
        let value = CandidValue.record(fields, Dictionary(uniqueKeysWithValues: entries.map { (Candid.fieldID($0.0), .blob($0.1)) }))
        return CandidArguments([try CandidTypedValue(type: .record(fields), value: value)])
    }

    static func record(_ entries: [(String, CandidType, CandidValue)]) -> (CandidType, CandidValue) {
        let fields = entries.map { CandidField($0.0, type: $0.1) }
        let values = Dictionary(uniqueKeysWithValues: entries.map { (Candid.fieldID($0.0), $0.2) })
        return (.record(fields), .record(fields, values))
    }

    static func mutationArguments(
        actionTag: String,
        actionType: CandidType,
        actionValue: CandidValue,
        operation: Data
    ) throws -> CandidArguments {
        let variantFields = [CandidField(actionTag, type: actionType)]
        let variant = try CandidVariant(fields: variantFields, tag: actionTag, value: actionValue)
        let (mutationType, mutationValue) = record([
            ("action", .variant(variantFields), .variant(variant)),
            ("operation", .vector(.nat8), .blob(operation)),
        ])
        return CandidArguments([try CandidTypedValue(type: mutationType, value: mutationValue)])
    }

    static func saveInlineArguments(
        vault: Data,
        object: Data,
        expectedRevision: UInt64,
        requestOperation: Data,
        plainSize: UInt64,
        manifest: Data,
        chunkHashes: [Data],
        bytes: Data,
        contextHash: Data,
        mutationOperation: Data
    ) throws -> CandidArguments {
        let (beginType, beginValue) = record([
            ("vault", .vector(.nat8), .blob(vault)),
            ("object", .vector(.nat8), .blob(object)),
            ("expected_revision", .nat64, .nat64(expectedRevision)),
            ("operation", .vector(.nat8), .blob(requestOperation)),
            ("plain_size", .nat64, .nat64(plainSize)),
            ("manifest", .vector(.nat8), .blob(manifest)),
            ("chunk_hashes", [Data].candidType, chunkHashes.candidValue),
        ])
        let (saveInlineType, saveInlineValue) = record([
            ("request", beginType, beginValue),
            ("bytes", .vector(.nat8), .blob(bytes)),
            ("context_hash", .vector(.nat8), .blob(contextHash)),
        ])
        return try mutationArguments(
            actionTag: "SaveInline",
            actionType: saveInlineType,
            actionValue: saveInlineValue,
            operation: mutationOperation
        )
    }

    static func deleteObjectArguments(
        vault: Data,
        object: Data,
        expectedRevision: UInt64,
        mutationOperation: Data
    ) throws -> CandidArguments {
        let (deleteType, deleteValue) = record([
            ("vault", .vector(.nat8), .blob(vault)),
            ("object", .vector(.nat8), .blob(object)),
            ("expected_revision", .nat64, .nat64(expectedRevision)),
        ])
        return try mutationArguments(
            actionTag: "DeleteObject",
            actionType: deleteType,
            actionValue: deleteValue,
            operation: mutationOperation
        )
    }

    static func renameVaultArguments(
        vault: Data,
        name: String,
        expectedSequence: UInt64,
        mutationOperation: Data
    ) throws -> CandidArguments {
        let (renameType, renameValue) = record([
            ("vault", .vector(.nat8), .blob(vault)),
            ("name", .text, .text(name)),
            ("expected_sequence", .nat64, .nat64(expectedSequence)),
        ])
        return try mutationArguments(
            actionTag: "RenameVault",
            actionType: renameType,
            actionValue: renameValue,
            operation: mutationOperation
        )
    }

    static func unwrapRevisionMutation(_ value: CandidValue) throws -> CandidValue {
        guard case .variant(let mutation) = value,
              mutation.tag == Candid.fieldID("Revision")
        else {
            throw VaultNativeError.invalidResponse
        }
        return mutation.value
    }

    static func matchesReconciledInlineManifest(
        _ revisionValue: CandidValue,
        vault: Data,
        object: Data,
        expectedNextRevision: UInt64,
        plainSize: UInt64,
        manifest: Data,
        chunkHashes: [Data]
    ) throws -> UInt64? {
        let deleted: Bool = try field("deleted", revisionValue)
        let returnedVault: Data = try field("vault", revisionValue)
        let returnedObject: Data = try field("object", revisionValue)
        let returnedRevision: UInt64 = try field("revision", revisionValue)
        let returnedSequence: UInt64 = try field("sequence", revisionValue)
        let returnedPlainSize: UInt64 = try field("plain_size", revisionValue)
        let returnedManifest: Data = try field("manifest", revisionValue)
        let returnedHashes: [Data] = try field("chunk_hashes", revisionValue)
        guard !deleted,
              returnedSequence > 0,
              returnedVault == vault,
              returnedObject == object,
              returnedRevision == expectedNextRevision,
              returnedPlainSize == plainSize,
              returnedManifest == manifest,
              returnedHashes == chunkHashes
        else {
            return nil
        }
        return returnedSequence
    }
}

public struct VaultNativeHeader: Sendable, Identifiable, Equatable {
    public let id: Data
    public let name: String
    public let nonce: Data
    public let keyName: String
    public let publicKey: Data
    public let sequence: UInt64

    public init(
        id: Data,
        name: String,
        nonce: Data,
        keyName: String,
        publicKey: Data,
        sequence: UInt64
    ) {
        self.id = id
        self.name = name
        self.nonce = nonce
        self.keyName = keyName
        self.publicKey = publicKey
        self.sequence = sequence
    }

    init(_ value: CandidValue) throws {
        id = try VaultWire.field("id", value)
        nonce = try VaultWire.field("nonce", value)
        publicKey = try VaultWire.field("public_key", value)
        keyName = try VaultWire.field("key_name", value)
        name = try VaultWire.field("name", value, as: Optional<String>.self) ?? "Unnamed Vault"
        sequence = try VaultWire.field("sequence", value)
        guard case .variant(let state) = try VaultWire.rawField("state", value) else { throw VaultNativeError.invalidResponse }
        if ["Deleting", "Pending"].contains(where: { state.tag == Candid.fieldID($0) }) { throw VaultNativeError.accessLost }
        guard state.tag == Candid.fieldID("Active"), id.count == 16, nonce.count == 32, publicKey.count == 96, !keyName.isEmpty, keyName.utf8.count <= 64 else { throw VaultNativeError.invalidResponse }
    }

    public func context(canister: String, owner: String) throws -> VaultContext {
        try VaultContext(canister: canister, owner: owner, vault: id, nonce: nonce, keyName: keyName)
    }
}

/// All authorization-sensitive reads use certified update replies, matching Web.
public actor VaultNativeClient {
    private let configuration: ICClientConfiguration
    private let local: Bool
    private let client: ICClient
    private struct Attempt {
        let operation: Data
        let transport: VaultNativeTransport
    }
    private struct PendingInlineKey: Hashable {
        let vault: Data
        let existingObject: Data?
        let expectedRevision: UInt64
        let payloadDigest: Data
    }
    private struct PendingInlineSave {
        let object: Data
        let nextRevision: UInt64
        let plainSize: UInt64
        let encrypted: EncryptedVaultDocumentV3
        let requestOperation: Data
        let mutationOperation: Data
        let context: VaultContext
        let rootKey: SymmetricKey
    }
    private var epoch = 0
    public func forgetKeys() { epoch += 1; attempts.removeAll(); roots.removeAll(); pendingInlineSaves.removeAll() }
    private var attempts: [Data: Attempt] = [:]
    private var roots: [Data: SymmetricKey] = [:]
    private var pendingInlineSaves: [PendingInlineKey: PendingInlineSave] = [:]

    public init(configuration: ICClientConfiguration, local: Bool, session: URLSession = .shared) {
        self.configuration = configuration; self.local = local
        client = ICClient(configuration: configuration, session: session)
    }

    public static func isValidVaultName(_ value: String) -> Bool {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= 64 else { return false }
        return !trimmed.unicodeScalars.contains { scalar in
            scalar.value < 32 || (scalar.value >= 127 && scalar.value <= 159)
        }
    }

    private func call(_ method: String, _ arguments: CandidArguments = CandidArguments(), identity: ICAuthSession) async throws -> CandidValue {
        try Task.checkCancellation()
        let ticket = epoch
        let reply = try await client.callCandid(method: method, arguments: arguments, identity: identity)
        guard epoch == ticket else { throw CancellationError() }
        guard reply.values.count == 1 else { throw VaultNativeError.invalidResponse }
        do { return try VaultWire.unwrap(reply.values[0].value) }
        catch VaultNativeError.notFound where method != "get_chunk" && method != "mutate" && method != "get_manifest" { throw VaultNativeError.accessLost }
    }

    public func initializeAccount(identity: ICAuthSession) async throws {
        _ = try await call("initialize_vault_account", identity: identity)
    }

    public func ownedVaults(identity: ICAuthSession) async throws -> [VaultNativeHeader] {
        let values = try VaultWire.array(await call("list_vaults", identity: identity))
        return try values.compactMap { value in
            guard case .variant(let state) = try VaultWire.rawField("state", value) else { throw VaultNativeError.invalidResponse }
            guard state.tag == Candid.fieldID("Active") else { return nil }
            return try VaultNativeHeader(value)
        }
    }

    public func createVault(identity: ICAuthSession) async throws -> VaultNativeHeader {
        let operation = try Self.randomBytes16()
        let reply = try await call("create_vault", try VaultWire.bytesRecord([("operation", operation)]), identity: identity)
        return try VaultNativeHeader(reply)
    }

    public func renameVault(header selected: VaultNativeHeader, name: String, identity: ICAuthSession) async throws {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard Self.isValidVaultName(trimmed) else { throw VaultNativeError.invalidInput }
        let current = try await header(selected.id, identity: identity)
        let operation = try Self.randomBytes16()
        let args = try VaultWire.renameVaultArguments(
            vault: current.id,
            name: trimmed,
            expectedSequence: current.sequence,
            mutationOperation: operation
        )
        _ = try await call("mutate", args, identity: identity)
    }

    private func header(_ id: Data, identity: ICAuthSession) async throws -> VaultNativeHeader {
        try VaultNativeHeader(await call("get_vault_header", CandidArguments(id), identity: identity))
    }

    private static func randomBytes16() throws -> Data {
        var bytes = [UInt8](repeating: 0, count: 16)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw VaultCryptoError.randomFailure
        }
        return Data(bytes)
    }

    private func ensureRootKey(
        header selected: VaultNativeHeader,
        identity: ICAuthSession
    ) async throws -> (VaultNativeHeader, VaultContext, SymmetricKey) {
        let ticket = epoch
        let first = try await header(selected.id, identity: identity)
        let context = try first.context(canister: configuration.canisterId, owner: identity.principal)
        guard first.nonce == selected.nonce, first.keyName == selected.keyName, first.publicKey == selected.publicKey else {
            throw VaultNativeError.changedDuringSync
        }
        var binding = try context.contextInput(); binding.append(first.publicKey)
        let root: SymmetricKey
        if let cached = roots[binding] {
            root = cached
        } else {
            let attempt: Attempt
            if let existing = attempts[binding] {
                attempt = existing
            } else {
                attempt = Attempt(operation: try Self.randomBytes16(), transport: try VaultNativeTransport())
                attempts[binding] = attempt
            }
            // Keep this exact transport+operation until the reply is verified, even on network errors.
            let reply = try await call(
                "derive_vault_key",
                try VaultWire.bytesRecord([
                    ("vault", first.id),
                    ("operation", attempt.operation),
                    ("transport", attempt.transport.publicKey),
                ]),
                identity: identity
            )
            root = try attempt.transport.rootKey(
                context: context,
                headerPublicKey: first.publicKey,
                replyInput: VaultWire.field("input", reply),
                replyPublicKey: VaultWire.field("public_key", reply),
                encryptedKey: VaultWire.field("encrypted_key", reply),
                local: local
            )
            guard epoch == ticket else { throw CancellationError() }
            roots[binding] = root
            attempts[binding] = nil
        }
        return (first, context, root)
    }

    public func fetchSnapshot(header selected: VaultNativeHeader, identity: ICAuthSession) async throws -> VaultAutoFillSyncPayload {
        let ticket = epoch
        let (first, context, root) = try await ensureRootKey(header: selected, identity: identity)
        let before = try await header(first.id, identity: identity)
        guard before.nonce == first.nonce, before.publicKey == first.publicKey, before.keyName == first.keyName else {
            throw VaultNativeError.changedDuringSync
        }
        var records: [VaultAutoFillRecordSnapshot] = []
        var cursor = Data()
        var seenCursors = Set<Data>()
        repeat {
            guard seenCursors.insert(cursor).inserted else { throw VaultNativeError.invalidResponse }
            let page = try await call("list_objects", VaultWire.arguments(CandidTypedValue(first.id), CandidTypedValue(cursor)), identity: identity)
            for revision in try VaultWire.array(VaultWire.rawField("entries", page)) {
                let deleted: Bool = try VaultWire.field("deleted", revision)
                if deleted { continue }
                let object: Data = try VaultWire.field("object", revision)
                let vault: Data = try VaultWire.field("vault", revision)
                let rev: UInt64 = try VaultWire.field("revision", revision)
                let manifest: Data = try VaultWire.field("manifest", revision)
                guard vault == first.id else { throw VaultNativeError.invalidResponse }
                let parsed = try VaultDocumentV3.readManifest(rootKey: root, context: context, object: object, revision: rev, manifestBytes: manifest)
                // Cache credentials and secure notes (<= 256 KiB); skip large multi-MB attachments.
                guard parsed.metadata.kind == .credential || parsed.metadata.kind == .note else { continue }
                let hashes: [Data] = try VaultWire.field("chunk_hashes", revision)
                guard hashes.count == parsed.chunkCount else { throw VaultNativeError.invalidResponse }
                var chunks: [Data] = []
                for index in 0..<parsed.chunkCount {
                    let chunk = try await VaultWire.readSnapshotObject {
                        try Data(candidValue: await self.call("get_chunk", VaultWire.arguments(CandidTypedValue(first.id), CandidTypedValue(object), CandidTypedValue(rev), CandidTypedValue(UInt32(index))), identity: identity))
                    } revalidate: {
                        _ = try await self.header(first.id, identity: identity)
                    }
                    chunks.append(chunk)
                }
                // Validate every chunk before publishing a usable offline cache.
                var plaintext = try VaultDocumentV3.decrypt(rootKey: root, context: context, object: object, revision: rev, manifestBytes: manifest, chunks: chunks, hashes: hashes).plaintext
                plaintext.resetBytes(in: 0..<plaintext.count)
                records.append(VaultAutoFillRecordSnapshot(objectIdBase64URL: Base64URL.encode(object), revision: rev, manifestBase64URL: Base64URL.encode(manifest), chunksBase64URL: chunks.map(Base64URL.encode), hashesBase64URL: hashes.map(Base64URL.encode)))
            }
            cursor = try VaultWire.field("next", page, as: Optional<Data>.self) ?? Data()
        } while !cursor.isEmpty
        let after = try await header(first.id, identity: identity)
        guard epoch == ticket else { throw CancellationError() }
        guard after == before else { throw VaultNativeError.changedDuringSync }
        return VaultAutoFillSyncPayload(snapshot: VaultAutoFillSnapshot(context: context, records: records), rootKey: root)
    }

    private func reconcileInlineSave(
        _ pending: PendingInlineSave,
        vault: Data,
        identity: ICAuthSession
    ) async throws -> VaultNativeSavedRecord? {
        do {
            let reply = try await call(
                "get_manifest",
                VaultWire.arguments(
                    CandidTypedValue(vault),
                    CandidTypedValue(pending.object),
                    CandidTypedValue(pending.nextRevision)
                ),
                identity: identity
            )
            guard let sequence = try VaultWire.matchesReconciledInlineManifest(
                reply,
                vault: vault,
                object: pending.object,
                expectedNextRevision: pending.nextRevision,
                plainSize: pending.plainSize,
                manifest: pending.encrypted.manifest,
                chunkHashes: pending.encrypted.hashes
            ) else {
                return nil
            }
            let snapshotRecord = VaultAutoFillRecordSnapshot(
                objectIdBase64URL: Base64URL.encode(pending.object),
                revision: pending.nextRevision,
                manifestBase64URL: Base64URL.encode(pending.encrypted.manifest),
                chunksBase64URL: pending.encrypted.chunks.map(Base64URL.encode),
                hashesBase64URL: pending.encrypted.hashes.map(Base64URL.encode)
            )
            return VaultNativeSavedRecord(
                snapshotRecord: snapshotRecord,
                rootKey: pending.rootKey,
                context: pending.context,
                revision: pending.nextRevision,
                sequence: sequence
            )
        } catch VaultNativeError.notFound {
            return nil
        }
    }

    public func saveInline(
        header selected: VaultNativeHeader,
        metadata: VaultMetadata,
        plaintext: Data,
        existingObject: Data? = nil,
        expectedRevision: UInt64 = 0,
        identity: ICAuthSession
    ) async throws -> VaultNativeSavedRecord {
        guard plaintext.count <= VaultDocumentV3.maxNoteBytes else {
            throw VaultCryptoError.sizeLimit
        }
        if let existingObject {
            guard existingObject.count == 16 else { throw VaultCryptoError.invalidInput }
        }
        let ticket = epoch
        let (first, context, root) = try await ensureRootKey(header: selected, identity: identity)

        let digestEncoder = JSONEncoder()
        digestEncoder.outputFormatting = [.sortedKeys]
        var digestInput = try digestEncoder.encode(metadata)
        digestInput.append(plaintext)
        let pendingKey = PendingInlineKey(
            vault: first.id,
            existingObject: existingObject,
            expectedRevision: expectedRevision,
            payloadDigest: Data(SHA256.hash(data: digestInput))
        )

        let pending: PendingInlineSave
        let wasRetrying: Bool
        if let existingPending = pendingInlineSaves[pendingKey],
           existingPending.context == context {
            pending = existingPending
            wasRetrying = true
        } else {
            let object = try existingObject ?? Self.randomBytes16()
            let nextRevision = expectedRevision + 1
            let encrypted = try VaultDocumentV3.encrypt(
                rootKey: root,
                context: context,
                object: object,
                revision: nextRevision,
                metadata: metadata,
                plaintext: plaintext
            )
            guard encrypted.chunks.count == 1, encrypted.hashes.count == 1 else {
                throw VaultCryptoError.sizeLimit
            }
            pending = PendingInlineSave(
                object: object,
                nextRevision: nextRevision,
                plainSize: UInt64(plaintext.count),
                encrypted: encrypted,
                requestOperation: try Self.randomBytes16(),
                mutationOperation: try Self.randomBytes16(),
                context: context,
                rootKey: root
            )
            wasRetrying = false
        }

        // If a previous attempt had an ambiguous transport failure, reconcile by exact manifest
        // before dispatching another mutation to prevent duplicate creations.
        if wasRetrying,
           let reconciled = try? await reconcileInlineSave(pending, vault: first.id, identity: identity) {
            guard epoch == ticket else { throw CancellationError() }
            pendingInlineSaves[pendingKey] = nil
            return reconciled
        }

        pendingInlineSaves[pendingKey] = pending
        let contextHash = Data(SHA256.hash(data: try context.contextInput()))
        let args = try VaultWire.saveInlineArguments(
            vault: first.id,
            object: pending.object,
            expectedRevision: expectedRevision,
            requestOperation: pending.requestOperation,
            plainSize: pending.plainSize,
            manifest: pending.encrypted.manifest,
            chunkHashes: pending.encrypted.hashes,
            bytes: pending.encrypted.chunks[0],
            contextHash: contextHash,
            mutationOperation: pending.mutationOperation
        )

        do {
            let reply = try await call("mutate", args, identity: identity)
            guard epoch == ticket else { throw CancellationError() }
            let revisionValue = try VaultWire.unwrapRevisionMutation(reply)
            let returnedVault: Data = try VaultWire.field("vault", revisionValue)
            let returnedObject: Data = try VaultWire.field("object", revisionValue)
            let returnedRevision: UInt64 = try VaultWire.field("revision", revisionValue)
            let returnedSequence: UInt64 = try VaultWire.field("sequence", revisionValue)
            guard returnedVault == first.id,
                  returnedObject == pending.object,
                  returnedRevision == pending.nextRevision
            else {
                throw VaultNativeError.invalidResponse
            }
            pendingInlineSaves[pendingKey] = nil

            let snapshotRecord = VaultAutoFillRecordSnapshot(
                objectIdBase64URL: Base64URL.encode(pending.object),
                revision: returnedRevision,
                manifestBase64URL: Base64URL.encode(pending.encrypted.manifest),
                chunksBase64URL: pending.encrypted.chunks.map(Base64URL.encode),
                hashesBase64URL: pending.encrypted.hashes.map(Base64URL.encode)
            )
            return VaultNativeSavedRecord(
                snapshotRecord: snapshotRecord,
                rootKey: root,
                context: context,
                revision: returnedRevision,
                sequence: returnedSequence
            )
        } catch let error as VaultNativeError {
            // A certified canister error on a fresh attempt is definite; on a retry of an
            // ambiguous attempt (e.g. Conflict after receipt GC), check whether the revision landed.
            if wasRetrying,
               let reconciled = try? await reconcileInlineSave(pending, vault: first.id, identity: identity) {
                guard epoch == ticket else { throw CancellationError() }
                pendingInlineSaves[pendingKey] = nil
                return reconciled
            }
            if !wasRetrying {
                pendingInlineSaves[pendingKey] = nil
            }
            throw error
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            // Ambiguous transport failure: keep the pending operation IDs and try immediate reconciliation.
            if let reconciled = try? await reconcileInlineSave(pending, vault: first.id, identity: identity) {
                guard epoch == ticket else { throw CancellationError() }
                pendingInlineSaves[pendingKey] = nil
                return reconciled
            }
            throw error
        }
    }

    public func deleteObject(
        header selected: VaultNativeHeader,
        object: Data,
        expectedRevision: UInt64,
        identity: ICAuthSession
    ) async throws {
        guard object.count == 16 else { throw VaultCryptoError.invalidInput }
        let args = try VaultWire.deleteObjectArguments(
            vault: selected.id,
            object: object,
            expectedRevision: expectedRevision,
            mutationOperation: try Self.randomBytes16()
        )
        _ = try await call("mutate", args, identity: identity)
    }
}
