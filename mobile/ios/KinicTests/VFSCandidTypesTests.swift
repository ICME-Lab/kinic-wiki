// Where: mobile/ios/KinicTests/VFSCandidTypesTests.swift
// What: didc-derived wire fixtures for every native VFS request and reply path.
// Why: Typed models must stay aligned with crates/vfs_canister/vfs.did independently of the app codec.

import Foundation
import ICNativeClient
import Testing
@testable import Kinic

struct VFSCandidTypesTests {
    @Test
    func allVFSRequestsMatchDIDGoldens() throws {
        let empty = try CandidArguments().encode()
        #expect(empty == fixture("4449444c0000")) // listReadableDatabases
        #expect(empty == fixture("4449444c0000")) // listPublicDatabases
        #expect(empty == fixture("4449444c0000")) // getCyclesBillingConfig
        #expect(empty == fixture("4449444c0000")) // deleteAccount

        let market = CandidArguments([
            try CandidTypedValue(Optional<String>.none),
            try CandidTypedValue(UInt32(100)),
        ])
        #expect(try market.encode() == fixture("4449444c016e710200790064000000"))

        let readNode = CandidArguments([
            try CandidTypedValue("db_demo"),
            try CandidTypedValue("/Knowledge/page.md"),
        ])
        let readNodeGolden = fixture("4449444c000271710764625f64656d6f122f4b6e6f776c656467652f706167652e6d64")
        #expect(try readNode.encode() == readNodeGolden) // readNode
        #expect(try readNode.encode() == readNodeGolden) // readBrowseNode

        let sql = CandidArguments([
            try CandidTypedValue("db_demo"),
            try CandidTypedValue("SELECT 1"),
            try CandidTypedValue(UInt32(1)),
        ])
        #expect(try sql.encode() == fixture("4449444c00037171790764625f64656d6f0853454c454354203101000000"))

        let writeNode = VFSWriteNodeRequest(
            databaseId: "db_demo",
            path: "/Knowledge/page.md",
            kind: .file,
            content: "hello",
            metadataJson: "{}",
            expectedEtag: nil
        )
        #expect(try encoded(writeNode) == fixture("4449444c036c06b99adecb0171d4c2a7b80401a5cbc7d20471fcc2a1eb0602b8c8dc8509719f9bbd940a716b03ced593f1027f9cf5d3f4027ffbc998b6067f6e7101000568656c6c6f01122f4b6e6f776c656467652f706167652e6d6400027b7d0764625f64656d6f"))

        let pathRequest = VFSPathRequest(databaseId: "db_demo", path: "/Knowledge/page.md")
        let pathGolden = fixture("4449444c016c02a5cbc7d204719f9bbd940a710100122f4b6e6f776c656467652f706167652e6d640764625f64656d6f")
        #expect(try encoded(pathRequest) == pathGolden) // getNodePublication
        #expect(try encoded(pathRequest) == pathGolden) // publishNode
        #expect(try encoded(pathRequest) == pathGolden) // unpublishNode

        let deleteNode = VFSDeleteNodeRequest(
            databaseId: "db_demo",
            path: "/Knowledge/page.md",
            expectedEtag: "etag-current"
        )
        #expect(try encoded(deleteNode) == fixture("4449444c026c04a5cbc7d20471fcc2a1eb06019f9bbd940a718ce2e9cc0d016e710100122f4b6e6f776c656467652f706167652e6d64010c657461672d63757272656e740764625f64656d6f00"))

        let children = VFSPathRequest(databaseId: "db_demo", path: "/Knowledge")
        #expect(try encoded(children) == fixture("4449444c016c02a5cbc7d204719f9bbd940a7101000a2f4b6e6f776c656467650764625f64656d6f"))

        let search = VFSSearchNodesRequest(databaseId: "db_demo", queryText: "swift", prefix: nil, topK: 20)
        #expect(try encoded(search) == fixture("4449444c046c058192bda101799f9bbd940a71bae497e80a0192b3dbf50a0384c18dff0b716e026b03b681a8417f89a9b095037fd8fd8c9f037f6e710100140000000764625f64656d6f010000057377696674"))

        #expect(try encoded(VFSCreateDatabaseRequest(name: "Team skills")) == fixture("4449444c016c01cbe4fdc7047101000b5465616d20736b696c6c73"))

        let metadata = VFSUpdateDatabaseMetadataRequest(
            databaseId: "db_demo",
            name: "Team DB",
            description: "Team description",
            llmSummary: nil,
            tagsJson: "[]"
        )
        #expect(try encoded(metadata) == fixture("4449444c026c0594d7ab4501cbe4fdc70471fc91f4f805719f9bbd940a718eed9d890f716e71010000075465616d204442105465616d206465736372697074696f6e0764625f64656d6f025b5d"))

        let databaseID = CandidArguments([try CandidTypedValue("db_demo")])
        let databaseIDGolden = fixture("4449444c0001710764625f64656d6f")
        #expect(try databaseID.encode() == databaseIDGolden) // listDatabaseMembers
        #expect(try databaseID.encode() == databaseIDGolden) // listDatabaseCyclesPendingPurchases

        let grant = CandidArguments([
            try CandidTypedValue("db_demo"),
            try CandidTypedValue("aaaaa-aa"),
            try CandidTypedValue(DatabaseRole.writer),
        ])
        #expect(try grant.encode() == fixture("4449444c016b03e3b29889037fd395e9930b7f939090dd0c7f037171000764625f64656d6f0861616161612d616101"))

        let revoke = CandidArguments([
            try CandidTypedValue("db_demo"),
            try CandidTypedValue("aaaaa-aa"),
        ])
        #expect(try revoke.encode() == fixture("4449444c000271710764625f64656d6f0861616161612d6161"))

        let cycleEntries = CandidArguments([
            try CandidTypedValue("db_demo"),
            try CandidTypedValue(Optional<UInt64>.some(12)),
            try CandidTypedValue(UInt32(20)),
        ])
        #expect(try cycleEntries.encode() == fixture("4449444c016e78037100790764625f64656d6f010c0000000000000014000000"))

        #expect(try encoded(VFSDatabaseIDRequest(databaseId: "db_demo")) == fixture("4449444c016c019f9bbd940a7101000764625f64656d6f"))

        let writeNodes = VFSWriteNodesRequest(
            databaseId: "db_demo",
            nodes: [
                VFSWriteNodeItem(
                    content: "hello",
                    kind: .file,
                    path: "/Sources/request.md",
                    expectedEtag: nil,
                    metadataJson: "{}"
                ),
            ]
        )
        #expect(try encoded(writeNodes) == fixture("4449444c056c02b1f0fafd09019f9bbd940a716d026c05b99adecb0171d4c2a7b80403a5cbc7d20471fcc2a1eb0604b8c8dc8509716b03ced593f1027f9cf5d3f4027ffbc998b6067f6e710100010568656c6c6f01132f536f75726365732f726571756573742e6d6400027b7d0764625f64656d6f"))

        let sourceSession = VFSSourceCaptureTriggerSessionRequest(databaseId: "db_demo", sessionNonce: "session-nonce-1")
        #expect(try encoded(sourceSession) == fixture("4449444c016c0286a09bb905719f9bbd940a7101000f73657373696f6e2d6e6f6e63652d310764625f64656d6f"))
    }

    @Test
    func requestDecodingRetainsOptionalSchemaFields() throws {
        let search: VFSSearchNodesRequest = try decoded(
            "4449444c046c058192bda101799f9bbd940a71bae497e80a0192b3dbf50a0384c18dff0b716e026b03b681a8417f89a9b095037fd8fd8c9f037f6e710100140000000764625f64656d6f010000057377696674"
        )
        guard case .some(.light) = search.previewMode else {
            Issue.record("Expected Light preview mode")
            return
        }

        let delete: VFSDeleteNodeRequest = try decoded(
            "4449444c026c04a5cbc7d20471fcc2a1eb06019f9bbd940a718ce2e9cc0d016e710100122f4b6e6f776c656467652f706167652e6d64010c657461672d63757272656e740764625f64656d6f010c666f6c6465722d696e646578"
        )
        #expect(delete.expectedFolderIndexEtag == "folder-index")
    }

    @Test
    func allVFSRepliesDecodeFromDIDGoldens() throws {
        let databases: VFSCandidResult<[DatabaseSummary], String> = try decoded(Fixtures.databaseSummaries)
        #expect(try databases.textValue().first?.databaseId == "db_demo") // listReadableDatabases
        #expect(try databases.textValue().first?.databaseId == "db_demo") // listPublicDatabases

        let entitlements: VFSCandidResult<MarketEntitlementPage, String> = try decoded(Fixtures.entitlements)
        #expect(try entitlements.textValue().entitlements.first?.orderId == "order-1")

        let billing: VFSCandidResult<CyclesBillingConfig, String> = try decoded(Fixtures.billing)
        #expect(try billing.textValue().topUp.thresholdCycles == 1_000)

        let node: VFSCandidResult<VFSNode?, String> = try decoded(Fixtures.readNode)
        #expect(try node.textValue()?.path == "/Knowledge/page.md") // readNode
        #expect(try node.textValue()?.path == "/Knowledge/page.md") // readBrowseNode

        let sql: VFSCandidResult<VFSSQLJSONResult, String> = try decoded(Fixtures.sql)
        #expect(try sql.textValue().rowCount == 1)

        let write: VFSCandidResult<VFSWriteNodeResult, VFSNodeMutationFailure> = try decoded(Fixtures.writeNode)
        #expect(try write.mutationValue().node.etag == "etag-1")

        let optionalPublication: VFSCandidResult<NodePublication?, String> = try decoded(Fixtures.publicationOptional)
        #expect(try optionalPublication.textValue()?.publicId == "public-1")

        let publication: VFSCandidResult<NodePublication, String> = try decoded(Fixtures.publication)
        #expect(try publication.textValue().publicId == "public-1")

        let unit: VFSCandidResult<CandidNull, String> = try decoded(Fixtures.unit)
        #expect(try unit.textValue() == CandidNull()) // unpublishNode
        #expect(try unit.textValue() == CandidNull()) // grantDatabaseAccess
        #expect(try unit.textValue() == CandidNull()) // revokeDatabaseAccess
        #expect(try unit.textValue() == CandidNull()) // deleteDatabase
        #expect(try unit.textValue() == CandidNull()) // deleteAccount
        #expect(try unit.textValue() == CandidNull()) // authorizeSourceCaptureTriggerSession

        let deleted: VFSCandidResult<VFSDeleteNodeResult, VFSNodeMutationFailure> = try decoded(Fixtures.deleteNode)
        #expect(try deleted.mutationValue().path == "/Knowledge/page.md")

        let children: VFSCandidResult<[ChildNode], String> = try decoded(Fixtures.children)
        #expect(try children.textValue().first?.kind == .folder)

        let search: VFSCandidResult<[SearchNodeHit], String> = try decoded(Fixtures.search)
        #expect(try search.textValue().first?.previewExcerpt == "swift")

        let created: VFSCandidResult<CreatedDatabase, String> = try decoded(Fixtures.created)
        #expect(try created.textValue().status == .pending)

        let metadata: VFSCandidResult<DatabaseMetadata, String> = try decoded(Fixtures.metadata)
        #expect(try metadata.textValue().llmSummary == "summary")

        let members: VFSCandidResult<[DatabaseMember], String> = try decoded(Fixtures.members)
        #expect(try members.textValue().first?.role == .writer)

        let cycleEntries: VFSCandidResult<DatabaseCycleEntryPage, String> = try decoded(Fixtures.cycleEntries)
        #expect(try cycleEntries.textValue().entries.first?.entryId == 1)

        let pending: VFSCandidResult<[DatabaseCyclesPendingPurchase], String> = try decoded(Fixtures.pendingPurchases)
        #expect(try pending.textValue().first?.operationId == 1)

        let writes: VFSCandidResult<[VFSWriteNodeResult], VFSNodeMutationFailure> = try decoded(Fixtures.writeNodes)
        #expect(try writes.mutationValue().first?.node.path == "/Sources/request.md")
    }

    @Test
    func optionalVectorAndErrorRepliesUseCompleteSchemas() throws {
        let missingNode: VFSCandidResult<VFSNode?, String> = try decoded(Fixtures.readNodeNil)
        #expect(try missingNode.textValue() == nil)

        let emptyChildren: VFSCandidResult<[ChildNode], String> = try decoded(Fixtures.emptyChildren)
        #expect(try emptyChildren.textValue().isEmpty)

        let textFailure: VFSCandidResult<CandidNull, String> = try decoded(Fixtures.textError)
        #expect(throws: VFSCandidError.canisterRejected("denied")) {
            try textFailure.textValue()
        }

        let mutationFailure: VFSCandidResult<VFSWriteNodeResult, VFSNodeMutationFailure> = try decoded(Fixtures.mutationError)
        do {
            _ = try mutationFailure.mutationValue()
            Issue.record("Expected mutation rejection")
        } catch let VFSCandidError.nodeMutationRejected(failure) {
            #expect(failure.code == .etagConflict)
            #expect(failure.failedIndex == 2)
            #expect(failure.conflictPath == "/Knowledge/page.md")
        }

        #expect(throws: ICClientError.self) {
            let overflow: VFSCandidResult<CyclesBillingConfig, String> = try decoded(Fixtures.billingOverflow)
            _ = try overflow.textValue()
        }
    }

    private func encoded<T: CandidConvertible>(_ value: T) throws -> Data {
        try CandidArguments(value).encode()
    }

    private func decoded<T: CandidConvertible>(_ hex: String) throws -> T {
        try CandidDecoder().decode(fixture(hex)).decode(T.self)
    }

    private func fixture(_ hex: String) -> Data {
        precondition(hex.count.isMultiple(of: 2), "Hex fixture must contain complete bytes")
        var data = Data()
        data.reserveCapacity(hex.count / 2)
        var index = hex.startIndex
        while index < hex.endIndex {
            let next = hex.index(index, offsetBy: 2)
            guard let byte = UInt8(hex[index..<next], radix: 16) else {
                preconditionFailure("Hex fixture contains a non-hexadecimal byte")
            }
            data.append(byte)
            index = next
        }
        return data
    }
}

private enum Fixtures {
    static let databaseSummaries = "4449444c0a6b02bc8a0101c5fed201716d026c09b2ceef2f03aac1e24704efcee7800405cbe4fdc70471f6d6bbdd0408a3eac8cd0578dcf0ddf006099f9bbd940a71cca0d6920f096b03e6ebead6047fb99b82810e7fb780f7c90f7f6e786e066c0494d7ab4507cbe4fdc70471fc91f4f805718eed9d890f716e716b03e3b29889037fd395e9930b7f939090dd0c7f6e7401000001000164000000000000000100075465616d2044420b4465736372697074696f6e025b5d047465616d022a00000000000000000764625f64656d6f00"
    static let entitlements = "4449444c056b02bc8a0101c5fed201716c02e2dfdfb20b02a6bccea40d036e716d046c06b2ceef2f71f6b6d6f808749f9bbd940a71e2c299d60b71ac9ce7810c71b6aaef9d0c7101000001046e65787401066163746976650a000000000000000764625f64656d6f0861616161612d6161076f726465722d31096c697374696e672d31"
    static let billing = "4449444c036b02bc8a0101c5fed201716c069bd0eaec03719e8f87f80371d281d496087185c2c2a90902d6dfcfab09789682a6b10a786c038189c4f1077ee1fc9cc3087dcf9f9ff10c710100000762696c6c696e6703696170066c656467657201e8070861616161612d616114000000000000001e00000000000000"
    static let readNode = "4449444c046b02bc8a0101c5fed201716e026c07b7fff5810174b99adecb017195ceeb980471d4c2a7b80403a5cbc7d20471aaacd9d00674b8c8dc8509716b03ced593f1027f9cf5d3f4027ffbc998b6067f0100000114000000000000000568656c6c6f06657461672d3101122f4b6e6f776c656467652f706167652e6d640a00000000000000027b7d"
    static let readNodeNil = "4449444c046b02bc8a0101c5fed201716e026c07b7fff5810174b99adecb017195ceeb980471d4c2a7b80403a5cbc7d20471aaacd9d00674b8c8dc8509716b03ced593f1027f9cf5d3f4027ffbc998b6067f01000000"
    static let sql = "4449444c036b02bc8a0101c5fed201716c0399eabbdd0402aafb93b90579bbbe84a807796d71010000010d7b2270617468223a222f61227d0100000001000000"
    static let writeNode = "4449444c086b02bc8a0101c5fed201046c02e8ebaa8b017e8294a8c804026c04b7fff581017495ceeb980471d4c2a7b80403a5cbc7d204716b03ced593f1027f9cf5d3f4027ffbc998b6067f6c04ade2928e0405f29bb7fe0506d0a7d4e10607c7ebc4d009716b05d1cbf7fc047fcfa0def2067fa7adc0b40d7fd9d18baf0e7fd09cd38e0f7f6e716e7901000001140000000000000006657461672d3101122f4b6e6f776c656467652f706167652e6d64"
    static let publicationOptional = "4449444c036b02bc8a0101c5fed201716e026c04f181e8f10371a5cbc7d20471e1e78fc407749f9bbd940a7101000001087075626c69632d31122f4b6e6f776c656467652f706167652e6d6414000000000000000764625f64656d6f"
    static let publication = "4449444c026b02bc8a0101c5fed201716c04f181e8f10371a5cbc7d20471e1e78fc407749f9bbd940a71010000087075626c69632d31122f4b6e6f776c656467652f706167652e6d6414000000000000000764625f64656d6f"
    static let unit = "4449444c016b02bc8a017fc5fed20171010000"
    static let deleteNode = "4449444c066b02bc8a0101c5fed201026c01a5cbc7d204716c04ade2928e0403f29bb7fe0504d0a7d4e10605c7ebc4d009716b05d1cbf7fc047fcfa0def2067fa7adc0b40d7fd9d18baf0e7fd09cd38e0f7f6e716e79010000122f4b6e6f776c656467652f706167652e6d64"
    static let children = "4449444c076b02bc8a0101c5fed201716d026c09b7fff581010395ceeb980404d4c2a7b80405cbe4fdc70471adeee5cf0406a5cbc7d20471d9b793ff077e84acfc9b0a7ef69a9d8e0f7e6e746e716b04ced593f1027f9cf5d3f4027ffbc998b6067fcda4df900b7f6e78010000010114000000000000000106657461672d310306466f6c64657200112f4b6e6f776c656467652f466f6c646572000100"
    static let search = "4449444c096b02bc8a0101c5fed201716d026c0688c0ebde0303d4c2a7b80407a5cbc7d20471f5d7bab50508ddd9d8c60606d2e6e5c607736e046c04baa9ce04059ce2a9c70279bef5d2fb0271c188c0b40a066b02c5a3aca9037f99eaa2b60e7f6e716b03ced593f1027f9cf5d3f4027ffbc998b6067f6d710100000101010400000007636f6e74656e740105737769667401122f4b6e6f776c656467652f706167652e6d640107636f6e74656e74010573776966740000c03f"
    static let created = "4449444c036b02bc8a0101c5fed201716c04b2ceef2f02cbe4fdc70471e298a498077e9f9bbd940a716b03e6ebead6047fb99b82810e7fb780f7c90f7f01000002075465616d204442000764625f64656d6f"
    static let metadata = "4449444c036b02bc8a0101c5fed201716c0494d7ab4502cbe4fdc70471fc91f4f805718eed9d890f716e71010000010773756d6d617279075465616d2044420b4465736372697074696f6e025b5d"
    static let members = "4449444c046b02bc8a0101c5fed201716d026c04ae9db1900171f6d6bbdd04039babbbe007749f9bbd940a716b03e3b29889037fd395e9930b7f939090dd0c7f010000010861616161612d6161010a000000000000000764625f64656d6f"
    static let cycleEntries = "4449444c066b02bc8a0101c5fed201716c02d0dafcca0702e2dfdfb20b056d036c0ce1edeb4a049297979b0205d4c2a7b80471d3e0f4c306789babbbe00774d6dfcfab09058af9f8ad09059f9bbd940a71d4ffaef40a748ba9a1b70b71869899970c05c899dda30c786e716e7801000001010a77726974655f6e6f64650105000000000000000663686172676564000000000000000a000000000000000102000000000000000103000000000000000764625f64656d6ffcffffffffffffff0861616161612d61610104000000000000000100000000000000010200000000000000"
    static let pendingPurchases = "4449444c046b02bc8a0101c5fed201716d026c08b2ceef2f719297979b0278b380e78f06789babbbe00774d6ebdcf708718af9f8ad09039f9bbd940a71d4ffaef40a786e78010000010770656e64696e67050000000000000001000000000000000a000000000000000477616974000764625f64656d6f6400000000000000"
    static let writeNodes = "4449444c096b02bc8a0101c5fed201056d026c02e8ebaa8b017e8294a8c804036c04b7fff581017495ceeb980471d4c2a7b80404a5cbc7d204716b03ced593f1027f9cf5d3f4027ffbc998b6067f6c04ade2928e0406f29bb7fe0507d0a7d4e10608c7ebc4d009716b05d1cbf7fc047fcfa0def2067fa7adc0b40d7fd9d18baf0e7fd09cd38e0f7f6e716e790100000101140000000000000006657461672d3101132f536f75726365732f726571756573742e6d64"
    static let textError = "4449444c016b02bc8a017fc5fed201710100010664656e696564"
    static let mutationError = "4449444c086b02bc8a0101c5fed201046c02e8ebaa8b017e8294a8c804026c04b7fff581017495ceeb980471d4c2a7b80403a5cbc7d204716b03ced593f1027f9cf5d3f4027ffbc998b6067f6c04ade2928e0405f29bb7fe0506d0a7d4e10607c7ebc4d009716b05d1cbf7fc047fcfa0def2067fa7adc0b40d7fd9d18baf0e7fd09cd38e0f7f6e716e790100010201122f4b6e6f776c656467652f706167652e6d6401020000000d6574616720636f6e666c696374"
    static let emptyChildren = "4449444c076b02bc8a0101c5fed201716d026c09b7fff581010395ceeb980404d4c2a7b80405cbe4fdc70471adeee5cf0406a5cbc7d20471d9b793ff077e84acfc9b0a7ef69a9d8e0f7e6e746e716b04ced593f1027f9cf5d3f4027ffbc998b6067fcda4df900b7f6e7801000000"
    static let billingOverflow = "4449444c036b02bc8a0101c5fed201716c069bd0eaec03719e8f87f80371d281d496087185c2c2a90902d6dfcfab09789682a6b10a786c038189c4f1077ee1fc9cc3087dcf9f9ff10c710100000762696c6c696e6703696170066c656467657201808080808080808080020861616161612d616114000000000000001e00000000000000"
}
