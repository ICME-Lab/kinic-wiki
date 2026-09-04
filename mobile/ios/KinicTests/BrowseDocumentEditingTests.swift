// Where: mobile/ios/KinicTests/BrowseDocumentEditingTests.swift
// What: Markdown edit eligibility, optimistic save, and draft-preservation tests.
// Why: Browse editing must never bypass roles or overwrite a newer remote revision.

import Foundation
import ICNativeClient
import Testing
@testable import Kinic

struct BrowseDocumentEditingTests {
    @MainActor
    @Test
    func editEligibilityRequiresWritableActiveMarkdownOutsideSources() throws {
        let fixture = try BrowseEditingFixture()
        defer { fixture.cleanup() }
        let model = fixture.model

        configure(model, role: .owner, status: .active, path: "/Knowledge/Page.md", kind: .file)
        #expect(model.canEditBrowseDocument("/Knowledge/Page.md"))

        configure(model, role: .writer, status: .active, path: "/Knowledge/Page.md", kind: .file)
        #expect(model.canEditBrowseDocument("/Knowledge/Page.md"))

        configure(model, role: .reader, status: .active, path: "/Knowledge/Page.md", kind: .file)
        #expect(!model.canEditBrowseDocument("/Knowledge/Page.md"))

        configure(model, role: .owner, status: .pending, path: "/Knowledge/Page.md", kind: .file)
        #expect(!model.canEditBrowseDocument("/Knowledge/Page.md"))

        configure(model, role: .owner, status: .deleted, path: "/Knowledge/Page.md", kind: .file)
        #expect(!model.canEditBrowseDocument("/Knowledge/Page.md"))

        configure(model, role: .owner, status: .active, path: "/Knowledge/Page.txt", kind: .file)
        #expect(!model.canEditBrowseDocument("/Knowledge/Page.txt"))

        configure(model, role: .owner, status: .active, path: "/Knowledge/Folder.md", kind: .folder)
        #expect(!model.canEditBrowseDocument("/Knowledge/Folder.md"))

        configure(model, role: .owner, status: .active, path: "/Sources/Page.md", kind: .file)
        #expect(!model.canEditBrowseDocument("/Sources/Page.md"))

        model.signOut()
        configure(model, role: .owner, status: .active, path: "/Knowledge/Page.md", kind: .file)
        #expect(!model.canEditBrowseDocument("/Knowledge/Page.md"))
    }

    @MainActor
    @Test
    func savePreservesRequestContractAndAppliesAcknowledgement() async throws {
        let ack = VFSWriteNodeResult(
            created: false,
            node: VFSNodeMutationAck(
                path: "/Knowledge/Page.md",
                kind: .file,
                updatedAt: 250,
                etag: "etag-new"
            )
        )
        let probe = BrowseDocumentWriteProbe(result: .success(ack))
        let fixture = try BrowseEditingFixture(probe: probe)
        defer { fixture.cleanup() }
        let model = fixture.model
        configure(model, role: .writer, status: .active, path: "/Knowledge/Page.md", kind: .file)
        model.loadedBrowsePath = "/Knowledge"
        model.childNodes = [
            ChildNode(
                path: "/Knowledge/Page.md",
                name: "Page.md",
                kind: .file,
                updatedAt: 100,
                etag: "etag-old",
                sizeBytes: 3,
                hasChildren: false,
                isVirtual: false
            )
        ]

        #expect(model.startEditingBrowseDocument("/Knowledge/Page.md"))
        model.updateBrowseDocumentDraft("updated Markdown")
        #expect(await model.saveBrowseDocument() == .saved)

        #expect(await probe.requests() == [
            BrowseDocumentWriteRequest(
                databaseId: "db_edit",
                path: "/Knowledge/Page.md",
                kind: .file,
                content: "updated Markdown",
                metadataJson: "{\"kept\":true}",
                expectedEtag: "etag-old"
            )
        ])
        #expect(model.documentNode?.content == "updated Markdown")
        #expect(model.documentNode?.etag == "etag-new")
        #expect(model.documentNode?.updatedAt == 250)
        #expect(model.childNodes.first?.etag == "etag-new")
        #expect(model.childNodes.first?.updatedAt == 250)
        #expect(model.childNodes.first?.sizeBytes == UInt64("updated Markdown".utf8.count))
        #expect(model.documentEditSession == nil)
    }

    @MainActor
    @Test
    func conflictKeepsOriginalDocumentAndDraft() async throws {
        let failure = VFSNodeMutationFailure(
            code: .etagConflict,
            message: "changed elsewhere",
            failedIndex: nil,
            conflictPath: "/Knowledge/Page.md"
        )
        let probe = BrowseDocumentWriteProbe(
            result: .failure(.nodeMutationRejected(failure))
        )
        let fixture = try BrowseEditingFixture(probe: probe)
        defer { fixture.cleanup() }
        let model = fixture.model
        configure(model, role: .owner, status: .active, path: "/Knowledge/Page.md", kind: .file)

        #expect(model.startEditingBrowseDocument("/Knowledge/Page.md"))
        model.updateBrowseDocumentDraft("my unsaved draft")
        #expect(await model.saveBrowseDocument() == .conflict)

        #expect(model.documentNode?.content == "old")
        #expect(model.documentNode?.etag == "etag-old")
        #expect(model.documentEditSession?.draftContent == "my unsaved draft")
        #expect(model.documentEditSession?.state == .conflict(failure))
    }

    @MainActor
    @Test
    func saveRejectionsLockWritingWhileTransportErrorsRemainRetryable() async throws {
        let failures: [(BrowseDocumentWriteProbe.Result, BrowseDocumentWriteRestriction?)] = [
            (
                .failure(.nodeMutationRejected(VFSNodeMutationFailure(
                    code: .forbidden,
                    message: "forbidden",
                    failedIndex: nil,
                    conflictPath: nil
                ))),
                .forbidden
            ),
            (
                .failure(.nodeMutationRejected(VFSNodeMutationFailure(
                    code: .writeUnavailable,
                    message: "paused",
                    failedIndex: nil,
                    conflictPath: nil
                ))),
                .writeUnavailable
            ),
            (.failure(.canisterRejected("offline")), nil)
        ]

        for (result, expectedRestriction) in failures {
            let probe = BrowseDocumentWriteProbe(result: result)
            let fixture = try BrowseEditingFixture(probe: probe)
            defer { fixture.cleanup() }
            let model = fixture.model
            configure(model, role: .owner, status: .active, path: "/Knowledge/Page.md", kind: .file)
            #expect(model.startEditingBrowseDocument("/Knowledge/Page.md"))
            model.updateBrowseDocumentDraft("keep this")

            guard case .failed = await model.saveBrowseDocument() else {
                Issue.record("Expected a retryable save failure")
                continue
            }
            #expect(model.documentNode?.content == "old")
            #expect(model.documentEditSession?.draftContent == "keep this")
            #expect(model.documentEditSession?.state == .editing)
            #expect(model.documentEditSession?.writeRestriction == expectedRestriction)

            if expectedRestriction != nil {
                guard case .failed = await model.saveBrowseDocument() else {
                    Issue.record("Expected a locally blocked save")
                    continue
                }
                #expect(await probe.requests().count == 1)
            }
        }
    }

    @MainActor
    @Test
    func signOutDiscardsInMemoryDraft() throws {
        let fixture = try BrowseEditingFixture()
        defer { fixture.cleanup() }
        let model = fixture.model
        configure(model, role: .owner, status: .active, path: "/Knowledge/Page.md", kind: .file)
        #expect(model.startEditingBrowseDocument("/Knowledge/Page.md"))
        model.updateBrowseDocumentDraft("private draft")

        model.signOut()

        #expect(model.documentEditSession == nil)
        #expect(!model.isSignedIn)
    }

    @MainActor
    @Test
    func deepLinkRequestCanBeCancelledWithoutDiscardingDraft() throws {
        let fixture = try BrowseEditingFixture()
        defer { fixture.cleanup() }
        let model = fixture.model
        configure(model, role: .owner, status: .active, path: "/Knowledge/Page.md", kind: .file)
        #expect(model.startEditingBrowseDocument("/Knowledge/Page.md"))
        model.updateBrowseDocumentDraft("private draft")

        model.handleOpenURL(URL(string: "https://wiki.kinic.xyz/db/db_next/Knowledge/Next.md")!)

        let request = try #require(model.requestedBrowseDeepLink)
        #expect(model.selectedBrowseDatabaseId == "db_edit")
        #expect(model.documentEditSession?.draftContent == "private draft")
        model.cancelBrowseDeepLink(request)
        #expect(model.requestedBrowseDeepLink == nil)
        #expect(model.selectedBrowseDatabaseId == "db_edit")
        #expect(model.documentEditSession?.draftContent == "private draft")
    }

    @MainActor
    @Test
    func applyingLatestDeepLinkDiscardsDraftAndIgnoresOlderRequest() throws {
        let fixture = try BrowseEditingFixture()
        defer { fixture.cleanup() }
        let model = fixture.model
        configure(model, role: .owner, status: .active, path: "/Knowledge/Page.md", kind: .file)
        #expect(model.startEditingBrowseDocument("/Knowledge/Page.md"))
        model.updateBrowseDocumentDraft("private draft")

        model.handleOpenURL(URL(string: "https://wiki.kinic.xyz/db/db_first/Knowledge/First.md")!)
        let first = try #require(model.requestedBrowseDeepLink)
        model.handleOpenURL(URL(string: "https://wiki.kinic.xyz/db/db_latest/Knowledge/Latest.md")!)
        let latest = try #require(model.requestedBrowseDeepLink)

        model.applyBrowseDeepLink(first)
        #expect(model.selectedBrowseDatabaseId == "db_edit")
        #expect(model.documentEditSession?.draftContent == "private draft")

        model.applyBrowseDeepLink(latest)
        #expect(model.selectedBrowseDatabaseId == "db_latest")
        #expect(model.documentEditSession == nil)
    }

    @MainActor
    @Test
    func replacedDeepLinkDoesNotStartOldDocumentLoadAfterParentLoadFinishes() async throws {
        let reader = ControlledBrowseDeepLinkReader()
        let fixture = try BrowseEditingFixture(
            readBrowseNodeRemotely: { databaseId, path, _ in
                await reader.read(databaseId: databaseId, path: path)
            },
            listBrowseChildrenRemotely: { _, _, _ in [] }
        )
        defer { fixture.cleanup() }
        let model = fixture.model

        model.handleOpenURL(URL(string: "https://wiki.kinic.xyz/db/db_old/Knowledge/Old.md")!)
        model.applyBrowseDeepLink(try #require(model.requestedBrowseDeepLink))
        try await waitForBlockedOldParent(reader)

        model.handleOpenURL(URL(string: "https://wiki.kinic.xyz/db/db_new/Knowledge/New")!)
        model.applyBrowseDeepLink(try #require(model.requestedBrowseDeepLink))
        await reader.releaseOldParent()
        try await Task.sleep(for: .milliseconds(30))

        #expect(model.selectedBrowseDatabaseId == "db_new")
        #expect(await reader.readCount(databaseId: "db_old", path: "/Knowledge/Old.md") == 1)
    }

    @MainActor
    @Test
    func delayedDeepLinkParentLoadDoesNotReplaceNewSelectionInSameDatabase() async throws {
        let reader = ControlledSameDatabaseDeepLinkReader()
        let fixture = try BrowseEditingFixture(
            readBrowseNodeRemotely: { databaseId, path, _ in
                await reader.read(databaseId: databaseId, path: path)
            },
            listBrowseChildrenRemotely: { _, _, _ in [] }
        )
        defer { fixture.cleanup() }
        let model = fixture.model

        model.handleOpenURL(URL(string: "https://wiki.kinic.xyz/db/db_shared/Knowledge/A.md")!)
        model.applyBrowseDeepLink(try #require(model.requestedBrowseDeepLink))
        try await waitForBlockedSharedParent(reader)

        model.startLoadBrowseDocument("/Knowledge/B.md")
        for _ in 0..<100 where model.documentNode?.path != "/Knowledge/B.md" {
            try await Task.sleep(for: .milliseconds(5))
        }
        await reader.releaseParent()
        try await Task.sleep(for: .milliseconds(30))

        #expect(model.selectedBrowseNodePath == "/Knowledge/B.md")
        #expect(model.documentNode?.path == "/Knowledge/B.md")
        #expect(await reader.readCount(path: "/Knowledge/A.md") == 1)
    }

    @Test
    func documentModeResetsForAnotherPathAndWhenEditingEnds() {
        #expect(BrowseDocumentMode.modeForPathChange(hasMatchingEditSession: true) == .edit)
        #expect(BrowseDocumentMode.modeForPathChange(hasMatchingEditSession: false) == .preview)
        #expect(BrowseDocumentMode.edit.modeAfterEditSessionRemoval() == .preview)
        #expect(BrowseDocumentMode.raw.modeAfterEditSessionRemoval() == .raw)
    }

    @MainActor
    @Test
    func databaseSelectionRequiresDiscardAndOnlyLatestRequestCanApply() throws {
        let fixture = try BrowseEditingFixture()
        defer { fixture.cleanup() }
        let model = fixture.model
        configure(model, role: .owner, status: .active, path: "/Knowledge/Page.md", kind: .file)
        #expect(model.startEditingBrowseDocument("/Knowledge/Page.md"))
        model.updateBrowseDocumentDraft("private draft")

        let firstDisposition = model.requestBrowseDatabaseSelection("db_first")
        guard case .awaitingDiscard(let first) = firstDisposition else {
            Issue.record("Expected the first database selection to wait for discard")
            return
        }
        #expect(model.requestedTab == .browse)
        #expect(model.selectedBrowseDatabaseId == "db_edit")
        #expect(model.documentEditSession?.draftContent == "private draft")

        let latestDisposition = model.requestBrowseDatabaseSelection("db_latest")
        guard case .awaitingDiscard(let latest) = latestDisposition else {
            Issue.record("Expected the latest database selection to wait for discard")
            return
        }
        model.applyBrowseDatabaseSelection(first)
        #expect(model.selectedBrowseDatabaseId == "db_edit")
        #expect(model.documentEditSession?.draftContent == "private draft")

        model.cancelBrowseDatabaseSelection(latest)
        #expect(model.selectedBrowseDatabaseId == "db_edit")
        #expect(model.documentEditSession?.draftContent == "private draft")
        #expect(model.browseDatabaseSelectionResolution == BrowseDatabaseSelectionResolution(
            requestId: latest.id,
            databaseId: "db_latest",
            outcome: .cancelled
        ))

        guard case .awaitingDiscard(let approved) = model.requestBrowseDatabaseSelection("db_approved") else {
            Issue.record("Expected the approved database selection to wait for discard")
            return
        }
        model.applyBrowseDatabaseSelection(approved)
        #expect(model.selectedBrowseDatabaseId == "db_approved")
        #expect(model.documentEditSession == nil)
        #expect(model.browseDatabaseSelectionResolution?.outcome == .applied)
    }

    @MainActor
    @Test
    func lostDatabaseAccessKeepsDraftUntilExplicitDiscard() throws {
        let fixture = try BrowseEditingFixture()
        defer { fixture.cleanup() }
        let model = fixture.model
        configure(model, role: .writer, status: .active, path: "/Knowledge/Page.md", kind: .file)
        #expect(model.startEditingBrowseDocument("/Knowledge/Page.md"))
        model.updateBrowseDocumentDraft("copyable draft")

        model.readableDatabases = []
        model.memberBrowseDatabaseIds = []
        model.reconcileBrowseDatabaseAccessAfterRefresh()

        #expect(model.selectedBrowseDatabaseId == "db_edit")
        #expect(model.selectedBrowseNodePath == "/Knowledge/Page.md")
        #expect(model.documentEditSession?.draftContent == "copyable draft")
        #expect(model.documentEditSession?.writeRestriction == .accessRemoved)

        model.discardBrowseDocumentEdits()

        #expect(model.documentEditSession == nil)
        #expect(model.selectedBrowseDatabaseId.isEmpty)
        #expect(model.selectedBrowseNodePath == nil)
        #expect(model.documentNode == nil)
    }

    @MainActor
    @Test
    func writeAccessLossKeepsDraftAndRecoveryAllowsSave() async throws {
        let ack = VFSWriteNodeResult(
            created: false,
            node: VFSNodeMutationAck(
                path: "/Knowledge/Page.md",
                kind: .file,
                updatedAt: 250,
                etag: "etag-new"
            )
        )
        let probe = BrowseDocumentWriteProbe(result: .success(ack))
        let fixture = try BrowseEditingFixture(probe: probe)
        defer { fixture.cleanup() }
        let model = fixture.model
        configure(model, role: .writer, status: .active, path: "/Knowledge/Page.md", kind: .file)
        #expect(model.startEditingBrowseDocument("/Knowledge/Page.md"))
        model.updateBrowseDocumentDraft("keep this draft")

        setDatabaseAccess(model, role: .reader, status: .active)
        let restriction = "You no longer have permission to edit this document. Your draft was kept."
        #expect(model.browseDocumentEditRestrictionMessage("/Knowledge/Page.md") == restriction)
        #expect(await model.saveBrowseDocument() == .failed(restriction))
        #expect(await probe.requests().isEmpty)
        #expect(model.documentEditSession?.draftContent == "keep this draft")

        setDatabaseAccess(model, role: .writer, status: .active)
        #expect(model.browseDocumentEditRestrictionMessage("/Knowledge/Page.md") == nil)
        #expect(await model.saveBrowseDocument() == .saved)
        #expect(await probe.requests().count == 1)
    }

    @MainActor
    @Test(arguments: [
        VFSNodeMutationErrorCode.forbidden,
        VFSNodeMutationErrorCode.writeUnavailable
    ])
    func refreshedWriteAccessUnlocksBackendRejectedDraft(
        _ rejectionCode: VFSNodeMutationErrorCode
    ) async throws {
        let ack = VFSWriteNodeResult(
            created: false,
            node: VFSNodeMutationAck(
                path: "/Knowledge/Page.md",
                kind: .file,
                updatedAt: 250,
                etag: "etag-new"
            )
        )
        let probe = BrowseDocumentWriteProbe(results: [
            .failure(.nodeMutationRejected(VFSNodeMutationFailure(
                code: rejectionCode,
                message: "rejected",
                failedIndex: nil,
                conflictPath: nil
            ))),
            .success(ack)
        ])
        let fixture = try BrowseEditingFixture(probe: probe)
        defer { fixture.cleanup() }
        let model = fixture.model
        configure(model, role: .writer, status: .active, path: "/Knowledge/Page.md", kind: .file)
        #expect(model.startEditingBrowseDocument("/Knowledge/Page.md"))
        model.updateBrowseDocumentDraft("same draft")

        guard case .failed = await model.saveBrowseDocument() else {
            Issue.record("Expected the backend rejection to keep the draft")
            return
        }
        #expect(model.documentEditSession?.writeRestriction != nil)

        model.reconcileBrowseDocumentWriteRestriction()

        #expect(model.documentEditSession?.writeRestriction == nil)
        #expect(model.documentEditSession?.draftContent == "same draft")
        #expect(await model.saveBrowseDocument() == .saved)
        #expect(await probe.requests().count == 2)
    }

    @Test
    func navigationGateCancelsSearchFolderAndKeepsLatestDeepLink() {
        var gate = BrowseNavigationGate()
        let searchFolder = BrowseNavigationGate.Request.searchFolder("/Knowledge/Project")
        #expect(gate.request(searchFolder, hasUnsavedChanges: true) == nil)
        #expect(gate.pendingRequest == searchFolder)
        #expect(gate.cancel() == searchFolder)
        #expect(gate.pendingRequest == nil)

        let first = BrowseNavigationGate.Request.deepLink(BrowseDeepLinkRequest(
            databaseId: "db_first",
            nodePath: "/Knowledge/First.md"
        ))
        let latest = BrowseNavigationGate.Request.deepLink(BrowseDeepLinkRequest(
            databaseId: "db_latest",
            nodePath: "/Knowledge/Latest.md"
        ))
        #expect(gate.request(first, hasUnsavedChanges: true) == nil)
        #expect(gate.request(latest, hasUnsavedChanges: true) == nil)
        #expect(gate.confirm() == latest)
        #expect(gate.pendingRequest == nil)

        #expect(gate.request(first, hasUnsavedChanges: true) == nil)
        #expect(gate.request(searchFolder, hasUnsavedChanges: false) == searchFolder)
        #expect(gate.pendingRequest == nil)
    }
}

@MainActor
private func configure(
    _ model: AppModel,
    role: DatabaseRole,
    status: DatabaseStatus,
    path: String,
    kind: VFSNodeKind
) {
    setDatabaseAccess(model, role: role, status: status)
    model.selectedBrowseNodePath = path
    model.documentNode = VFSNode(
        path: path,
        kind: kind,
        content: "old",
        metadataJson: "{\"kept\":true}",
        etag: "etag-old",
        createdAt: 50,
        updatedAt: 100
    )
}

@MainActor
private func setDatabaseAccess(
    _ model: AppModel,
    role: DatabaseRole,
    status: DatabaseStatus
) {
    model.selectedBrowseDatabaseId = "db_edit"
    model.readableDatabases = [
        DatabaseSummary(
            databaseId: "db_edit",
            title: "Edit DB",
            description: "",
            metadata: nil,
            role: role,
            status: status,
            logicalSizeBytes: 0,
            cyclesBalance: nil,
            cyclesSuspendedAtMs: nil,
            deletedAtMs: nil
        )
    ]
}

@MainActor
private final class BrowseEditingFixture {
    let model: AppModel
    private let suiteName: String
    private let queueDirectory: URL

    init(
        probe: BrowseDocumentWriteProbe? = nil,
        readBrowseNodeRemotely: (@Sendable (String, String, KinicIdentitySession?) async throws -> VFSNode?)? = nil,
        listBrowseChildrenRemotely: (@Sendable (String, String, KinicIdentitySession?) async throws -> [ChildNode])? = nil
    ) throws {
        suiteName = "kinic.browse-editing-tests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defaults.removePersistentDomain(forName: suiteName)
        queueDirectory = FileManager.default.temporaryDirectory
            .appending(path: "kinic-browse-editing-tests")
            .appending(path: UUID().uuidString)
        model = AppModel(
            configuration: .preview,
            authService: try! KinicAuthService(configuration: .preview),
            client: try! KinicICClient(configuration: .preview),
            shareInbox: try ShareInbox(testQueueDirectory: queueDirectory),
            settingsStore: SharedDefaultsStore(defaults: defaults),
            writeBrowseDocumentRemotely: { request, _ in
                if let probe {
                    return try await probe.write(request)
                }
                return VFSWriteNodeResult(
                    created: false,
                    node: VFSNodeMutationAck(
                        path: request.path,
                        kind: request.kind,
                        updatedAt: 200,
                        etag: "etag-new"
                    )
                )
            },
            readBrowseNodeRemotely: readBrowseNodeRemotely,
            listBrowseChildrenRemotely: listBrowseChildrenRemotely,
            initialSession: browseEditingSession()
        )
    }

    func cleanup() {
        UserDefaults(suiteName: suiteName)?.removePersistentDomain(forName: suiteName)
        try? FileManager.default.removeItem(at: queueDirectory)
    }
}

private actor BrowseDocumentWriteProbe {
    enum Result: Sendable {
        case success(VFSWriteNodeResult)
        case failure(VFSCandidError)
    }

    private var results: [Result]
    private var recordedRequests: [BrowseDocumentWriteRequest] = []

    init(result: Result) {
        results = [result]
    }

    init(results: [Result]) {
        self.results = results
    }

    func write(_ request: BrowseDocumentWriteRequest) throws -> VFSWriteNodeResult {
        recordedRequests.append(request)
        let result = results.count > 1 ? results.removeFirst() : results[0]
        switch result {
        case .success(let value):
            return value
        case .failure(let error):
            throw error
        }
    }

    func requests() -> [BrowseDocumentWriteRequest] {
        recordedRequests
    }
}

private actor ControlledBrowseDeepLinkReader {
    private var requests: [(databaseId: String, path: String)] = []
    private var oldParentContinuation: CheckedContinuation<VFSNode?, Never>?

    func read(databaseId: String, path: String) async -> VFSNode? {
        requests.append((databaseId, path))
        if databaseId == "db_old", path == "/Knowledge/Old.md" {
            return VFSNode(
                path: path,
                kind: .file,
                content: "old",
                metadataJson: "",
                etag: "old-etag",
                createdAt: 1,
                updatedAt: 1
            )
        }
        if databaseId == "db_old", path == "/Knowledge" {
            return await withCheckedContinuation { continuation in
                oldParentContinuation = continuation
            }
        }
        if databaseId == "db_new", path == "/Knowledge/New" {
            return VFSNode(
                path: path,
                kind: .folder,
                content: "",
                metadataJson: "",
                etag: "new-etag",
                createdAt: 1,
                updatedAt: 1
            )
        }
        return nil
    }

    func hasBlockedOldParent() -> Bool {
        oldParentContinuation != nil
    }

    func releaseOldParent() {
        oldParentContinuation?.resume(returning: VFSNode(
            path: "/Knowledge",
            kind: .folder,
            content: "",
            metadataJson: "",
            etag: "parent-etag",
            createdAt: 1,
            updatedAt: 1
        ))
        oldParentContinuation = nil
    }

    func readCount(databaseId: String, path: String) -> Int {
        requests.count { $0.databaseId == databaseId && $0.path == path }
    }
}

private actor ControlledSameDatabaseDeepLinkReader {
    private var requests: [String] = []
    private var parentContinuation: CheckedContinuation<VFSNode?, Never>?

    func read(databaseId: String, path: String) async -> VFSNode? {
        guard databaseId == "db_shared" else {
            return nil
        }
        requests.append(path)
        switch path {
        case "/Knowledge/A.md":
            return document(path: path, content: "A")
        case "/Knowledge/B.md":
            return document(path: path, content: "B")
        case "/Knowledge":
            return await withCheckedContinuation { continuation in
                parentContinuation = continuation
            }
        default:
            return nil
        }
    }

    func hasBlockedParent() -> Bool {
        parentContinuation != nil
    }

    func releaseParent() {
        parentContinuation?.resume(returning: VFSNode(
            path: "/Knowledge",
            kind: .folder,
            content: "",
            metadataJson: "",
            etag: "parent-etag",
            createdAt: 1,
            updatedAt: 1
        ))
        parentContinuation = nil
    }

    func readCount(path: String) -> Int {
        requests.count { $0 == path }
    }

    private func document(path: String, content: String) -> VFSNode {
        VFSNode(
            path: path,
            kind: .file,
            content: content,
            metadataJson: "",
            etag: "\(content)-etag",
            createdAt: 1,
            updatedAt: 1
        )
    }
}

private func waitForBlockedOldParent(_ reader: ControlledBrowseDeepLinkReader) async throws {
    for _ in 0..<100 {
        if await reader.hasBlockedOldParent() {
            return
        }
        try await Task.sleep(for: .milliseconds(5))
    }
    Issue.record("Timed out waiting for the old parent read")
}

private func waitForBlockedSharedParent(_ reader: ControlledSameDatabaseDeepLinkReader) async throws {
    for _ in 0..<100 {
        if await reader.hasBlockedParent() {
            return
        }
        try await Task.sleep(for: .milliseconds(5))
    }
    Issue.record("Timed out waiting for the shared parent read")
}

private func browseEditingSession() -> KinicIdentitySession {
    .testing(principal: "aaaaa-aa")
}
