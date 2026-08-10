// Where: mobile/android/app/src/main/java/xyz/kinic/android/CaptureSubmissionCoordinator.kt
// What: Durable manual enqueue and single-flight pending capture submission helpers.
// Why: UI dismissal, queue persistence, and asynchronous IC submission have distinct success conditions.

package xyz.kinic.android

import kotlinx.coroutines.sync.Mutex
import xyz.kinic.android.ic.IcAuthSession
import java.net.URI

internal fun enqueueManualCapture(
    inbox: ShareInbox,
    url: String,
    databaseId: String,
    outputLanguage: WikiOutputLanguage,
): Result<PendingSharedUrl> =
    runCatching {
        inbox.enqueue(
            url = URI(url.trim()),
            databaseId = databaseId,
            outputLanguage = outputLanguage,
        )
    }

internal class CaptureSubmissionCoordinator(
    private val submit: suspend (IcAuthSession, DatabaseSummary?) -> String,
) {
    private val submissionMutex = Mutex()

    suspend fun submitNext(session: IcAuthSession, selectedDatabase: DatabaseSummary?): String? {
        if (!submissionMutex.tryLock()) return null
        return try {
            submit(session, selectedDatabase)
        } finally {
            submissionMutex.unlock()
        }
    }
}
