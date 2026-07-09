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

enum class DatabaseRole(val candidName: String, val canRead: Boolean, val canWrite: Boolean) {
    OWNER("Owner", canRead = true, canWrite = true),
    WRITER("Writer", canRead = true, canWrite = true),
    READER("Reader", canRead = true, canWrite = false),
}

enum class VfsNodeKind(val candidName: String) {
    FILE("File"),
    SOURCE("Source"),
    FOLDER("Folder"),
}

private fun String?.cleaned(): String? {
    val trimmed = this?.trim()
    return if (trimmed.isNullOrEmpty()) null else trimmed
}
