// Where: mobile/android/app/src/main/java/xyz/kinic/android/Models.kt
// What: Shared Android models for capture and minimal VFS operations.
// Why: Kotlin code should preserve the same domain terms used by the iOS app and canister.

package xyz.kinic.android

import java.net.URI
import java.time.Instant

data class SourceCaptureRequest(
    val databaseId: String,
    val requestId: String,
    val requestPath: String,
    val content: String,
    val metadataJson: String,
    val normalizedUrl: URI,
)

data class ShareCaptureMetadata(
    val title: String? = null,
    val description: String? = null,
    val imageUrl: URI? = null,
    val source: String,
    val fetchedAt: Instant = Instant.now(),
) {
    val hasContent: Boolean =
        title.cleaned() != null || description.cleaned() != null || imageUrl != null

    fun cleaned(): ShareCaptureMetadata =
        copy(title = title.cleaned(), description = description.cleaned())

    companion object {
        const val X_OPEN_GRAPH_SOURCE = "x_og_metadata"
    }
}

data class PendingSharedUrl(
    val id: String,
    val url: URI,
    val receivedAt: Instant,
    val requestId: String,
    val databaseId: String?,
    val captureMetadata: ShareCaptureMetadata?,
)

data class DatabaseSummary(
    val databaseId: String,
    val title: String,
    val description: String,
    val metadata: DatabaseMetadata?,
    val role: DatabaseRole,
    val status: DatabaseStatus,
    val logicalSizeBytes: ULong,
    val cyclesBalance: ULong?,
    val cyclesSuspendedAtMs: Long?,
    val deletedAtMs: Long?,
) {
    val canWrite: Boolean =
        status == DatabaseStatus.ACTIVE && role.canWrite

    val canRead: Boolean =
        status == DatabaseStatus.ACTIVE

    val displayTitle: String =
        title.ifBlank { databaseId }
}

data class DatabaseMetadata(
    val name: String,
    val description: String,
    val llmSummary: String?,
    val tagsJson: String,
)

enum class DatabaseRole(val candidName: String, val canRead: Boolean, val canWrite: Boolean) {
    OWNER("Owner", canRead = true, canWrite = true),
    WRITER("Writer", canRead = true, canWrite = true),
    READER("Reader", canRead = true, canWrite = false),
}

enum class DatabaseStatus(val candidName: String) {
    ACTIVE("Active"),
    DELETED("Deleted"),
    PENDING("Pending"),
}

enum class VfsNodeKind(val candidName: String) {
    FILE("File"),
    SOURCE("Source"),
    FOLDER("Folder"),
}

data class VfsNode(
    val path: String,
    val kind: VfsNodeKind,
    val content: String,
    val metadataJson: String,
    val etag: String,
    val createdAt: Long,
    val updatedAt: Long,
)

data class ChildNode(
    val path: String,
    val name: String,
    val kind: VfsNodeKind,
    val updatedAt: Long?,
    val etag: String?,
    val sizeBytes: ULong?,
    val hasChildren: Boolean,
    val isVirtual: Boolean,
)

data class SearchNodeHit(
    val path: String,
    val kind: VfsNodeKind,
    val snippet: String?,
    val previewExcerpt: String?,
    val matchReasons: List<String>,
    val score: Float,
)

data class CreatedDatabase(
    val databaseId: String,
    val name: String,
    val status: DatabaseStatus,
    val initialFreeGrantApplied: Boolean,
)

data class CyclesBillingConfig(
    val kinicLedgerCanisterId: String,
    val billingAuthorityId: String,
    val cyclesPerKinic: ULong,
    val minUpdateCycles: ULong,
    val topUp: CyclesTopUpConfig,
)

data class CyclesTopUpConfig(
    val enabled: Boolean,
    val launcherPrincipal: String,
    val thresholdCycles: ULong,
)

data class DatabaseMember(
    val principal: String,
    val role: DatabaseRole,
    val createdAtMs: Long,
)

data class DatabaseCycleEntry(
    val entryId: ULong,
    val databaseId: String,
    val kind: String,
    val amountCycles: Long,
    val balanceAfterCycles: ULong,
    val caller: String,
    val method: String?,
    val ledgerBlockIndex: ULong?,
    val paymentAmountE8s: ULong?,
    val cyclesPerKinic: ULong?,
    val cyclesDelta: ULong?,
    val createdAtMs: Long,
)

data class DatabaseCycleEntryPage(
    val entries: List<DatabaseCycleEntry>,
    val nextCursor: ULong?,
)

data class DatabaseCyclesPendingPurchase(
    val operationId: ULong,
    val databaseId: String,
    val status: String,
    val amountCycles: ULong,
    val paymentAmountE8s: ULong,
    val ledgerBlockIndex: ULong?,
    val createdAtMs: Long,
    val requiredAction: String,
)

data class MarketEntitlement(
    val databaseId: String,
    val buyerPrincipal: String,
    val listingId: String,
    val orderId: String,
    val purchasedAtMs: Long,
    val status: String,
)

data class MarketEntitlementPage(
    val entitlements: List<MarketEntitlement>,
    val nextCursor: String?,
)

private fun String?.cleaned(): String? {
    val trimmed = this?.trim()
    return if (trimmed.isNullOrEmpty()) null else trimmed
}
