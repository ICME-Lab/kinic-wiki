// Where: mobile/android/app/src/main/java/xyz/kinic/android/KinicIcClient.kt
// What: Typed IC boundary for source capture submission.
// Why: Source capture should call the canister through the same signed IC client used by the app.

package xyz.kinic.android

import xyz.kinic.android.ic.IcAuthSession
import xyz.kinic.android.ic.IcClient
import java.util.UUID

data class CaptureSubmission(
    val databaseId: String,
    val requestPath: String,
    val requestId: String,
    val url: String,
    val sessionNonce: String,
)

sealed class SourceCaptureSubmissionError(message: String) : Exception(message) {
    data class ConflictingRequest(val path: String) :
        SourceCaptureSubmissionError("Source capture request already exists with different content: $path")
}

class KinicIcClient(
    private val configuration: AppConfiguration,
    private val client: IcClient = IcClient(configuration.icClientConfiguration()),
    private val workerTrigger: SourceCaptureWorkerTrigger = HttpSourceCaptureWorkerTrigger(configuration),
) : SourceCaptureGateway {
    override suspend fun saveSourceCaptureRequest(
        request: SourceCaptureRequest,
        session: IcAuthSession,
    ): CaptureSubmission {
        validateSession(session)
        val sessionNonce = UUID.randomUUID().toString().lowercase()
        val existing = VfsCandidDecoder.decodeReadNodeResult(
            client.queryRaw(
                method = "read_node",
                arg = VfsCandidEncoder.readNode(request.databaseId, request.requestPath),
                identity = session,
            ),
        )
        if (existing != null) {
            if (!isSameSourceCaptureRequest(existing, request)) {
                throw SourceCaptureSubmissionError.ConflictingRequest(request.requestPath)
            }
        } else {
            VfsCandidDecoder.decodeWriteNodesResult(
                client.callRaw(
                    method = "write_nodes",
                    arg = VfsCandidEncoder.writeNodes(request),
                    identity = session,
                ),
            )
        }
        VfsCandidDecoder.decodeUnitResult(
            client.callRaw(
                method = "authorize_source_capture_trigger_session",
                arg = VfsCandidEncoder.authorizeSourceCaptureTriggerSession(
                    databaseId = request.databaseId,
                    sessionNonce = sessionNonce,
                ),
                identity = session,
            ),
        )
        return CaptureSubmission(
            databaseId = request.databaseId,
            requestPath = request.requestPath,
            requestId = request.requestId,
            url = request.normalizedUrl.toString(),
            sessionNonce = sessionNonce,
        )
    }

    override suspend fun triggerSourceCapture(submission: CaptureSubmission) {
        val result = workerTrigger.trigger(
            TriggerSourceCaptureRequest(
                canisterId = configuration.canisterId,
                databaseId = submission.databaseId,
                requestPath = submission.requestPath,
                sessionNonce = submission.sessionNonce,
            ),
        )
        if (!result.accepted) {
            throw IllegalStateException(result.error ?: "worker trigger failed")
        }
    }

    private fun validateSession(session: IcAuthSession) {
        require(session.canisterId == configuration.canisterId) {
            "auth session canister does not match configuration"
        }
        client.validateIdentity(session, configuration.canisterId)
    }
}

private fun isSameSourceCaptureRequest(existing: VfsNode, request: SourceCaptureRequest): Boolean =
    existing.path == request.requestPath &&
        existing.kind == VfsNodeKind.FILE &&
        existing.content == request.content &&
        existing.metadataJson == request.metadataJson
