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
    suspend fun listReadableDatabases(session: IcAuthSession): List<DatabaseSummary> {
        client.validateIdentity(session, configuration.canisterId)
        val data = client.queryRaw(
            method = "list_databases",
            arg = VfsCandidEncoder.empty(),
            identity = session,
        )
        return VfsCandidDecoder.decodeDatabaseSummaries(data)
            .filter(DatabaseSummary::canRead)
            .sortedBy { it.displayTitle.lowercase() }
    }

    suspend fun listBrowseChildren(databaseId: String, path: String, session: IcAuthSession): List<ChildNode> {
        client.validateIdentity(session, configuration.canisterId)
        val data = client.queryRaw(
            method = "list_children",
            arg = VfsCandidEncoder.listChildren(databaseId, path),
            identity = session,
        )
        return VfsCandidDecoder.decodeChildNodesResult(data)
            .sortedBrowseChildren()
    }

    suspend fun readBrowseNode(databaseId: String, path: String, session: IcAuthSession): VfsNode? {
        client.validateIdentity(session, configuration.canisterId)
        val data = client.queryRaw(
            method = "read_node",
            arg = VfsCandidEncoder.readNode(databaseId, path),
            identity = session,
        )
        return VfsCandidDecoder.decodeReadNodeResult(data)
    }
}

internal fun List<ChildNode>.sortedBrowseChildren(): List<ChildNode> =
    sortedWith(compareByDescending<ChildNode> { it.kind == VfsNodeKind.FOLDER }.thenBy { it.name.lowercase() })
