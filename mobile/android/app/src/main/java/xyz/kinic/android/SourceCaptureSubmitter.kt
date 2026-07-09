// Where: mobile/android/app/src/main/java/xyz/kinic/android/SourceCaptureSubmitter.kt
// What: Submit one queued Android source-capture request through authenticated IC calls.
// Why: UI and share entrypoints need identical retry semantics around write and worker trigger.

package xyz.kinic.android

import xyz.kinic.android.ic.IcAuthSession

interface SourceCaptureGateway {
    suspend fun saveSourceCaptureRequest(request: SourceCaptureRequest, session: IcAuthSession): CaptureSubmission
    suspend fun triggerSourceCapture(submission: CaptureSubmission)
}

typealias SourceCaptureDatabaseResolver = suspend (String, IcAuthSession) -> DatabaseSummary?

class SourceCaptureSubmitter(
    private val inbox: ShareInbox,
    private val gateway: SourceCaptureGateway,
    private val resolveDatabase: SourceCaptureDatabaseResolver,
) {
    suspend fun submitNextPendingUrl(session: IcAuthSession, selectedDatabase: DatabaseSummary?): String {
        val item = inbox.loadPendingUrls().firstOrNull() ?: return "No pending URLs."
        val database = try {
            if (item.databaseId != null) {
                resolveDatabase(item.databaseId, session)
                    ?: return "Queued database is not readable: ${item.databaseId}."
            } else {
                selectedDatabase ?: return "Select a writable database before submitting."
            }
        } catch (error: Exception) {
            return error.message ?: "Failed to resolve the queued database."
        }
        if (!database.canWrite) {
            return if (item.databaseId != null) {
                "Queued database is not writable: ${database.databaseId}."
            } else {
                "Selected database is not writable."
            }
        }
        return try {
            val request = SourceCaptureRequestBuilder.request(
                url = item.url,
                databaseId = database.databaseId,
                requestedBy = session.principal,
                requestId = item.requestId,
                now = item.receivedAt,
                captureMetadata = item.captureMetadata,
            )
            val submission = gateway.saveSourceCaptureRequest(request, session)
            try {
                gateway.triggerSourceCapture(submission)
                inbox.remove(item)
                "Saved ${submission.requestPath}."
            } catch (error: Exception) {
                "Saved ${submission.requestPath}, but capture could not start. It remains queued for retry: ${error.message ?: "trigger failed"}"
            }
        } catch (error: Exception) {
            error.message ?: "Source capture submission failed."
        }
    }
}
