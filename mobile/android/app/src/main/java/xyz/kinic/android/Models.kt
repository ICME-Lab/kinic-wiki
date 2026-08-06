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
    val outputLanguage: WikiOutputLanguage = WikiOutputLanguage.ENGLISH,
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
    val outputLanguage: WikiOutputLanguage = WikiOutputLanguage.ENGLISH,
)

enum class WikiOutputLanguage(val code: String, val displayName: String) {
    ENGLISH("en", "English"),
    JAPANESE("ja", "Japanese"),
    SIMPLIFIED_CHINESE("zh-Hans", "Chinese (Simplified)"),
    KOREAN("ko", "Korean"),
    SPANISH("es", "Spanish"),
    FRENCH("fr", "French"),
    GERMAN("de", "German"),
    PORTUGUESE("pt", "Portuguese");

    companion object {
        fun fromCode(code: String): WikiOutputLanguage? = entries.firstOrNull { it.code == code }
        fun fromSetting(value: String): WikiOutputLanguage =
            entries.firstOrNull { it.code == value || it.displayName.equals(value, ignoreCase = true) } ?: ENGLISH
    }
}

enum class SourceCaptureHistoryStatus(val workerValue: String) {
    QUEUED("queued"),
    FETCHING("fetching"),
    SOURCE_WRITTEN("source_written"),
    GENERATING("generating"),
    COMPLETED("completed"),
    FAILED("failed");

    companion object {
        fun fromWorkerValue(value: String): SourceCaptureHistoryStatus? =
            entries.firstOrNull { it.workerValue == value }
    }
}

data class SourceCaptureHistoryItem(
    val requestPath: String,
    val url: String,
    val status: SourceCaptureHistoryStatus,
    val requestedAtMilliseconds: Long,
    val updatedAtMilliseconds: Long,
    val claimedAt: String?,
    val sourcePath: String?,
    val targetPath: String?,
    val finishedAt: String?,
    val error: String?,
    val lastCheckedAtMilliseconds: Long? = null,
    val syncError: String? = null,
) {
    fun isRetryable(now: Instant = Instant.now()): Boolean =
        when (status) {
            SourceCaptureHistoryStatus.QUEUED,
            SourceCaptureHistoryStatus.SOURCE_WRITTEN,
            SourceCaptureHistoryStatus.FAILED,
            -> true
            SourceCaptureHistoryStatus.FETCHING -> claimedAt?.let {
                runCatching { Instant.parse(it) }.getOrNull()
            }?.let { now.epochSecond - it.epochSecond >= 15 * 60 } == true
            SourceCaptureHistoryStatus.GENERATING,
            SourceCaptureHistoryStatus.COMPLETED,
            -> false
        }
}

data class SourceCaptureHistoryRecord(
    val databaseId: String,
    val item: SourceCaptureHistoryItem,
) {
    val id: String = "$databaseId:${item.requestPath}"

    companion object {
        fun fromRequest(request: SourceCaptureRequest, requestedAt: Instant): SourceCaptureHistoryRecord =
            SourceCaptureHistoryRecord(
                databaseId = request.databaseId,
                item = SourceCaptureHistoryItem(
                    requestPath = request.requestPath,
                    url = request.normalizedUrl.toString(),
                    status = SourceCaptureHistoryStatus.QUEUED,
                    requestedAtMilliseconds = requestedAt.toEpochMilli(),
                    updatedAtMilliseconds = requestedAt.toEpochMilli(),
                    claimedAt = null,
                    sourcePath = null,
                    targetPath = null,
                    finishedAt = null,
                    error = null,
                ),
            )
    }
}

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
