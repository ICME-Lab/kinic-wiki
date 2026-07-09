// Where: mobile/android/app/src/main/java/xyz/kinic/android/SourceCaptureWorkerTrigger.kt
// What: HTTP trigger client for the source-capture worker.
// Why: After VFS write authorization, the worker contract is a small JSON POST.

package xyz.kinic.android

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.net.HttpURLConnection

data class TriggerSourceCaptureRequest(
    val canisterId: String,
    val databaseId: String,
    val requestPath: String,
    val sessionNonce: String,
)

data class TriggerSourceCaptureResult(
    val accepted: Boolean,
    val error: String?,
)

interface SourceCaptureWorkerTrigger {
    suspend fun trigger(request: TriggerSourceCaptureRequest): TriggerSourceCaptureResult
}

class HttpSourceCaptureWorkerTrigger(
    private val configuration: AppConfiguration,
) : SourceCaptureWorkerTrigger {
    override suspend fun trigger(request: TriggerSourceCaptureRequest): TriggerSourceCaptureResult =
        withContext(Dispatchers.IO) {
            runCatching {
                val openedConnection = configuration.sourceCaptureTriggerUrl.toURL().openConnection()
                if (openedConnection !is HttpURLConnection) {
                    return@runCatching TriggerSourceCaptureResult(
                        accepted = false,
                        error = "worker trigger failed: unsupported connection",
                    )
                }
                val connection = openedConnection
                val payload = jsonObjectSorted(
                    mapOf(
                        "canisterId" to request.canisterId,
                        "databaseId" to request.databaseId,
                        "requestPath" to request.requestPath,
                        "sessionNonce" to request.sessionNonce,
                    ),
                )
                connection.requestMethod = "POST"
                connection.doOutput = true
                connection.setRequestProperty("content-type", "application/json")
                connection.setRequestProperty("Origin", configuration.authOrigin.toString().trimEnd('/'))
                connection.outputStream.use { it.write(payload.encodeToByteArray()) }
                val status = connection.responseCode
                if (status in 200..299) {
                    TriggerSourceCaptureResult(accepted = true, error = null)
                } else {
                    val errorText = connection.errorStream?.bufferedReader()?.use { it.readText() }
                    TriggerSourceCaptureResult(
                        accepted = false,
                        error = "worker trigger failed: ${errorText ?: "HTTP $status"}",
                    )
                }
            }.getOrElse {
                TriggerSourceCaptureResult(accepted = false, error = it.message)
            }
        }
}
