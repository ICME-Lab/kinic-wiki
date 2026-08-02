// Where: mobile/android/app/src/main/java/xyz/kinic/android/KinicVfsClient.kt
// What: Typed Android VFS Browse queries over the raw IC client.
// Why: Browse UI should not parse Candid or construct IC envelopes directly.

package xyz.kinic.android

import xyz.kinic.android.ic.IcAuthSession
import xyz.kinic.android.ic.IcClient

class KinicVfsClient(
    private val configuration: AppConfiguration,
    private val client: IcClient = IcClient(configuration.icClientConfiguration()),
) {
    suspend fun listMemberDatabases(session: IcAuthSession): List<DatabaseSummary> {
        client.validateIdentity(session, configuration.canisterId)
        val data = client.queryRaw(
            method = "list_databases",
            arg = VfsCandidEncoder.empty(),
            identity = session,
        )
        return VfsCandidDecoder.decodeDatabaseSummaries(data)
            .sortedBy { it.displayTitle.lowercase() }
    }

    suspend fun listReadableDatabases(session: IcAuthSession): List<DatabaseSummary> =
        listMemberDatabases(session).filter(DatabaseSummary::canRead)

    suspend fun listPublicDatabases(): List<DatabaseSummary> {
        val data = client.queryRaw(
            method = "list_databases",
            arg = VfsCandidEncoder.empty(),
            identity = null,
        )
        return VfsCandidDecoder.decodeDatabaseSummaries(data)
            .filter(DatabaseSummary::canRead)
            .sortedBy { it.displayTitle.lowercase() }
    }

    suspend fun marketListEntitlements(
        session: IcAuthSession,
        cursor: String? = null,
        limit: UInt = 100u,
    ): MarketEntitlementPage {
        validate(session)
        val data = client.queryRaw(
            method = "market_list_entitlements",
            arg = VfsCandidEncoder.marketListEntitlements(cursor, limit),
            identity = session,
        )
        return VfsCandidDecoder.decodeMarketEntitlementPageResult(data)
    }

    suspend fun listBrowseChildren(databaseId: String, path: String, session: IcAuthSession?): List<ChildNode> {
        session?.let(::validate)
        val data = client.queryRaw(
            method = "list_children",
            arg = VfsCandidEncoder.listChildren(databaseId, path),
            identity = session,
        )
        return VfsCandidDecoder.decodeChildNodesResult(data)
            .sortedBrowseChildren()
    }

    suspend fun readBrowseNode(databaseId: String, path: String, session: IcAuthSession?): VfsNode? {
        session?.let(::validate)
        val data = client.queryRaw(
            method = "read_node",
            arg = VfsCandidEncoder.readNode(databaseId, path),
            identity = session,
        )
        return VfsCandidDecoder.decodeReadNodeResult(data)
    }

    suspend fun searchBrowseNodes(
        databaseId: String,
        query: String,
        prefix: String?,
        limit: UInt,
        session: IcAuthSession?,
    ): List<SearchNodeHit> {
        session?.let(::validate)
        val data = client.queryRaw(
            method = "search_nodes",
            arg = VfsCandidEncoder.searchNodes(databaseId, query, prefix, limit),
            identity = session,
        )
        return VfsCandidDecoder.decodeSearchNodeHitsResult(data)
    }

    suspend fun getCyclesBillingConfig(session: IcAuthSession): CyclesBillingConfig {
        validate(session)
        val data = client.queryRaw(
            method = "get_cycles_billing_config",
            arg = VfsCandidEncoder.empty(),
            identity = session,
        )
        return VfsCandidDecoder.decodeCyclesBillingConfigResult(data)
    }

    suspend fun createDatabase(name: String, session: IcAuthSession): CreatedDatabase {
        validate(session)
        val data = client.callRaw(
            method = "create_database",
            arg = VfsCandidEncoder.createDatabase(name),
            identity = session,
        )
        return VfsCandidDecoder.decodeCreateDatabaseResult(data)
    }

    suspend fun updateDatabaseMetadata(
        databaseId: String,
        name: String,
        description: String,
        llmSummary: String?,
        tagsJson: String,
        session: IcAuthSession,
    ): DatabaseMetadata {
        validate(session)
        val data = client.callRaw(
            method = "update_database_metadata",
            arg = VfsCandidEncoder.updateDatabaseMetadata(databaseId, name, description, llmSummary, tagsJson),
            identity = session,
        )
        return VfsCandidDecoder.decodeDatabaseMetadataResult(data)
    }

    suspend fun listDatabaseMembers(databaseId: String, session: IcAuthSession): List<DatabaseMember> {
        validate(session)
        val data = client.queryRaw(
            method = "list_database_members",
            arg = VfsCandidEncoder.textArgsForDatabase(databaseId),
            identity = session,
        )
        return VfsCandidDecoder.decodeDatabaseMembersResult(data)
            .sortedWith(compareBy<DatabaseMember> { it.role.ordinal }.thenBy { it.principal.lowercase() })
    }

    suspend fun grantDatabaseAccess(
        databaseId: String,
        principal: String,
        role: DatabaseRole,
        session: IcAuthSession,
    ) {
        validate(session)
        val data = client.callRaw(
            method = "grant_database_access",
            arg = VfsCandidEncoder.grantDatabaseAccess(databaseId, principal, role),
            identity = session,
        )
        VfsCandidDecoder.decodeUnitResult(data)
    }

    suspend fun revokeDatabaseAccess(databaseId: String, principal: String, session: IcAuthSession) {
        validate(session)
        val data = client.callRaw(
            method = "revoke_database_access",
            arg = VfsCandidEncoder.revokeDatabaseAccess(databaseId, principal),
            identity = session,
        )
        VfsCandidDecoder.decodeUnitResult(data)
    }

    suspend fun listDatabaseCycleEntries(
        databaseId: String,
        cursor: ULong?,
        limit: UInt,
        session: IcAuthSession,
    ): DatabaseCycleEntryPage {
        validate(session)
        val data = client.queryRaw(
            method = "list_database_cycle_entries",
            arg = VfsCandidEncoder.listDatabaseCycleEntries(databaseId, cursor, limit),
            identity = session,
        )
        return VfsCandidDecoder.decodeDatabaseCycleEntryPageResult(data)
    }

    suspend fun listDatabaseCyclesPendingPurchases(
        databaseId: String,
        session: IcAuthSession,
    ): List<DatabaseCyclesPendingPurchase> {
        validate(session)
        val data = client.queryRaw(
            method = "list_database_cycles_pending_purchases",
            arg = VfsCandidEncoder.textArgsForDatabase(databaseId),
            identity = session,
        )
        return VfsCandidDecoder.decodeDatabaseCyclesPendingPurchasesResult(data)
    }

    suspend fun deleteDatabase(databaseId: String, session: IcAuthSession) {
        validate(session)
        val data = client.callRaw(
            method = "delete_database",
            arg = VfsCandidEncoder.deleteDatabase(databaseId),
            identity = session,
        )
        VfsCandidDecoder.decodeUnitResult(data)
    }

    private fun validate(session: IcAuthSession) {
        client.validateIdentity(session, configuration.canisterId)
    }
}

internal fun List<ChildNode>.sortedBrowseChildren(): List<ChildNode> =
    sortedWith(compareByDescending<ChildNode> { it.kind == VfsNodeKind.FOLDER }.thenBy { it.name.lowercase() })
