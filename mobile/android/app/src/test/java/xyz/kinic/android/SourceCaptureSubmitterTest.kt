// Where: mobile/android/app/src/test/java/xyz/kinic/android/SourceCaptureSubmitterTest.kt
// What: JVM tests for pending source-capture submission semantics.
// Why: Android must remove queued URLs only after both IC write and worker trigger succeed.

package xyz.kinic.android

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import xyz.kinic.android.ic.IcAuthSession
import xyz.kinic.android.ic.IcIdentitySession
import xyz.kinic.android.ic.identityDelegation
import java.net.URI
import java.nio.file.Files
import java.time.Instant

class SourceCaptureSubmitterTest {
    @Test
    fun submitNextPendingUrlWritesAuthorizesTriggersAndRemovesItem() = runBlocking {
        val directory = Files.createTempDirectory("kinic-submit-test").toFile()
        try {
            val inbox = ShareInbox(directory)
            inbox.enqueue(
                url = URI("https://example.com/page"),
                receivedAt = Instant.ofEpochSecond(1_700_000_000),
                requestId = "1700000000000-00000000-0000-4000-8000-000000000000",
            )
            val gateway = RecordingSourceCaptureGateway()
            val message = sourceCaptureSubmitter(inbox, gateway).submitNextPendingUrl(
                testSession(),
                testDatabase("db_demo", DatabaseRole.WRITER),
            )

            assertEquals("Saved /Sources/source-capture-requests/1700000000000-00000000-0000-4000-8000-000000000000.md.", message)
            assertTrue(inbox.loadPendingUrls().isEmpty())
            assertEquals(listOf("save", "trigger"), gateway.calls)
            assertEquals("db_demo", gateway.savedRequests.single().databaseId)
        } finally {
            directory.deleteRecursively()
        }
    }

    @Test
    fun triggerFailureKeepsPendingItemForRetry() = runBlocking {
        val directory = Files.createTempDirectory("kinic-submit-trigger-test").toFile()
        try {
            val inbox = ShareInbox(directory)
            inbox.enqueue(
                url = URI("https://example.com/page"),
                receivedAt = Instant.ofEpochSecond(1_700_000_000),
                requestId = "1700000000000-00000000-0000-4000-8000-000000000000",
                databaseId = "db_from_item",
            )
            val gateway = RecordingSourceCaptureGateway(triggerFailuresRemaining = 1)
            val message = sourceCaptureSubmitter(
                inbox,
                gateway,
                resolver = { databaseId, _ -> testDatabase(databaseId, DatabaseRole.WRITER) },
            ).submitNextPendingUrl(
                testSession(),
                testDatabase("db_from_ui", DatabaseRole.WRITER),
            )

            assertTrue(message.contains("It remains queued for retry"))
            assertEquals(1, inbox.loadPendingUrls().size)
            assertEquals("db_from_item", gateway.savedRequests.single().databaseId)
        } finally {
            directory.deleteRecursively()
        }
    }

    @Test
    fun selectedDatabaseIsRequiredWhenPendingItemHasNoDatabase() = runBlocking {
        val directory = Files.createTempDirectory("kinic-submit-no-db-test").toFile()
        try {
            val inbox = ShareInbox(directory)
            inbox.enqueue(
                url = URI("https://example.com/page"),
                receivedAt = Instant.ofEpochSecond(1_700_000_000),
                requestId = "1700000000000-00000000-0000-4000-8000-000000000000",
            )
            val gateway = RecordingSourceCaptureGateway()
            val message = sourceCaptureSubmitter(inbox, gateway).submitNextPendingUrl(testSession(), null)

            assertEquals("Select a writable database before submitting.", message)
            assertEquals(1, inbox.loadPendingUrls().size)
            assertTrue(gateway.calls.isEmpty())
        } finally {
            directory.deleteRecursively()
        }
    }

    @Test
    fun readerDatabaseCannotBeUsedForSourceCaptureFallback() = runBlocking {
        val directory = Files.createTempDirectory("kinic-submit-reader-test").toFile()
        try {
            val inbox = ShareInbox(directory)
            inbox.enqueue(
                url = URI("https://example.com/page"),
                receivedAt = Instant.ofEpochSecond(1_700_000_000),
                requestId = "1700000000000-00000000-0000-4000-8000-000000000000",
            )
            val gateway = RecordingSourceCaptureGateway()
            val message = sourceCaptureSubmitter(inbox, gateway).submitNextPendingUrl(
                testSession(),
                testDatabase("db_reader", DatabaseRole.READER),
            )

            assertEquals("Selected database is not writable.", message)
            assertEquals(1, inbox.loadPendingUrls().size)
            assertTrue(gateway.calls.isEmpty())
        } finally {
            directory.deleteRecursively()
        }
    }

    @Test
    fun queuedDatabaseIsResolvedInsteadOfUsingSelectedDatabase() = runBlocking {
        val directory = Files.createTempDirectory("kinic-submit-queued-db-test").toFile()
        try {
            val inbox = ShareInbox(directory)
            inbox.enqueue(
                url = URI("https://example.com/page"),
                databaseId = "db_from_item",
            )
            val gateway = RecordingSourceCaptureGateway()
            val resolvedIds = mutableListOf<String>()
            val submitter = sourceCaptureSubmitter(
                inbox,
                gateway,
                resolver = { databaseId, _ ->
                    resolvedIds += databaseId
                    testDatabase(databaseId, DatabaseRole.OWNER)
                },
            )

            submitter.submitNextPendingUrl(testSession(), testDatabase("db_from_ui", DatabaseRole.WRITER))

            assertEquals(listOf("db_from_item"), resolvedIds)
            assertEquals("db_from_item", gateway.savedRequests.single().databaseId)
        } finally {
            directory.deleteRecursively()
        }
    }

    @Test
    fun unreadableQueuedDatabaseDoesNotSubmit() = runBlocking {
        val directory = Files.createTempDirectory("kinic-submit-unreadable-db-test").toFile()
        try {
            val inbox = ShareInbox(directory)
            inbox.enqueue(url = URI("https://example.com/page"), databaseId = "db_missing")
            val gateway = RecordingSourceCaptureGateway()

            val message = sourceCaptureSubmitter(inbox, gateway).submitNextPendingUrl(testSession(), null)

            assertEquals("Queued database is not readable: db_missing.", message)
            assertTrue(gateway.calls.isEmpty())
            assertEquals(1, inbox.loadPendingUrls().size)
        } finally {
            directory.deleteRecursively()
        }
    }

    @Test
    fun nonWritableQueuedDatabaseDoesNotSubmit() = runBlocking {
        val directory = Files.createTempDirectory("kinic-submit-reader-db-test").toFile()
        try {
            val inbox = ShareInbox(directory)
            inbox.enqueue(url = URI("https://example.com/page"), databaseId = "db_reader")
            val gateway = RecordingSourceCaptureGateway()
            val submitter = sourceCaptureSubmitter(
                inbox,
                gateway,
                resolver = { databaseId, _ -> testDatabase(databaseId, DatabaseRole.READER) },
            )

            val message = submitter.submitNextPendingUrl(testSession(), null)

            assertEquals("Queued database is not writable: db_reader.", message)
            assertTrue(gateway.calls.isEmpty())
            assertEquals(1, inbox.loadPendingUrls().size)
        } finally {
            directory.deleteRecursively()
        }
    }

    @Test
    fun inactiveQueuedDatabaseDoesNotSubmit() = runBlocking {
        val directory = Files.createTempDirectory("kinic-submit-inactive-db-test").toFile()
        try {
            val inbox = ShareInbox(directory)
            inbox.enqueue(url = URI("https://example.com/page"), databaseId = "db_deleted")
            val gateway = RecordingSourceCaptureGateway()
            val submitter = sourceCaptureSubmitter(
                inbox,
                gateway,
                resolver = { databaseId, _ ->
                    testDatabase(databaseId, DatabaseRole.OWNER, DatabaseStatus.DELETED)
                },
            )

            val message = submitter.submitNextPendingUrl(testSession(), null)

            assertEquals("Queued database is not writable: db_deleted.", message)
            assertTrue(gateway.calls.isEmpty())
            assertEquals(1, inbox.loadPendingUrls().size)
        } finally {
            directory.deleteRecursively()
        }
    }

    @Test
    fun triggerFailureCanBeRetriedAndThenRemovesPendingItem() = runBlocking {
        val directory = Files.createTempDirectory("kinic-submit-retry-test").toFile()
        try {
            val inbox = ShareInbox(directory)
            inbox.enqueue(url = URI("https://example.com/page"), databaseId = "db_writer")
            val gateway = RecordingSourceCaptureGateway(triggerFailuresRemaining = 1)
            val submitter = sourceCaptureSubmitter(
                inbox,
                gateway,
                resolver = { databaseId, _ -> testDatabase(databaseId, DatabaseRole.WRITER) },
            )

            val first = submitter.submitNextPendingUrl(testSession(), null)
            val second = submitter.submitNextPendingUrl(testSession(), null)

            assertTrue(first.contains("It remains queued for retry"))
            assertTrue(second.startsWith("Saved "))
            assertTrue(inbox.loadPendingUrls().isEmpty())
            assertEquals(listOf("save", "trigger", "save", "trigger"), gateway.calls)
        } finally {
            directory.deleteRecursively()
        }
    }
}

private class RecordingSourceCaptureGateway(
    private var triggerFailuresRemaining: Int = 0,
) : SourceCaptureGateway {
    val calls = mutableListOf<String>()
    val savedRequests = mutableListOf<SourceCaptureRequest>()

    override suspend fun saveSourceCaptureRequest(request: SourceCaptureRequest, session: IcAuthSession): CaptureSubmission {
        calls += "save"
        savedRequests += request
        return CaptureSubmission(
            databaseId = request.databaseId,
            requestPath = request.requestPath,
            requestId = request.requestId,
            url = request.normalizedUrl.toString(),
            sessionNonce = "nonce",
        )
    }

    override suspend fun triggerSourceCapture(submission: CaptureSubmission) {
        calls += "trigger"
        if (triggerFailuresRemaining > 0) {
            triggerFailuresRemaining -= 1
            throw IllegalStateException("trigger failed")
        }
    }
}

private fun sourceCaptureSubmitter(
    inbox: ShareInbox,
    gateway: SourceCaptureGateway,
    resolver: SourceCaptureDatabaseResolver = { _, _ -> null },
): SourceCaptureSubmitter =
    SourceCaptureSubmitter(inbox = inbox, gateway = gateway, resolveDatabase = resolver)

private fun testSession(): IcAuthSession {
    val configuration = testAppConfiguration().icClientConfiguration()
    val privateKey = IcIdentitySession.generateSessionPrivateKey()
    return IcIdentitySession.makeSession(identityDelegation(privateKey, configuration.canisterId), privateKey, configuration)
}

private fun testDatabase(
    databaseId: String,
    role: DatabaseRole,
    status: DatabaseStatus = DatabaseStatus.ACTIVE,
): DatabaseSummary =
    DatabaseSummary(
        databaseId = databaseId,
        title = databaseId,
        description = "",
        metadata = null,
        role = role,
        status = status,
        logicalSizeBytes = 0uL,
        cyclesBalance = null,
        cyclesSuspendedAtMs = null,
        deletedAtMs = null,
    )
