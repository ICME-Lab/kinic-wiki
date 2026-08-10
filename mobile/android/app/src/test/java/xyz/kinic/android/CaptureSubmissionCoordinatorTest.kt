package xyz.kinic.android

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import xyz.kinic.android.ic.IcAuthSession
import xyz.kinic.android.ic.IcIdentityBridge
import xyz.kinic.android.ic.identityPayload
import java.io.File
import java.nio.file.Files

class CaptureSubmissionCoordinatorTest {
    @Test
    fun manualEnqueueReturnsSuccessOnlyAfterDurableWrite() {
        val directory = Files.createTempDirectory("kinic-manual-enqueue-test").toFile()
        try {
            val inbox = ShareInbox(directory)
            val result = enqueueManualCapture(
                inbox = inbox,
                url = " https://example.com/page#section ",
                databaseId = "db_demo",
                outputLanguage = WikiOutputLanguage.JAPANESE,
            )

            assertTrue(result.isSuccess)
            assertEquals("https://example.com/page", inbox.loadPendingUrls().single().url.toString())
            assertEquals(WikiOutputLanguage.JAPANESE, inbox.loadPendingUrls().single().outputLanguage)
        } finally {
            directory.deleteRecursively()
        }
    }

    @Test
    fun manualEnqueueRejectsMalformedUrlWithoutWriting() {
        val directory = Files.createTempDirectory("kinic-manual-invalid-test").toFile()
        try {
            val inbox = ShareInbox(directory)
            val result = enqueueManualCapture(inbox, "not a URL", "db_demo", WikiOutputLanguage.ENGLISH)

            assertTrue(result.isFailure)
            assertTrue(inbox.loadPendingUrls().isEmpty())
        } finally {
            directory.deleteRecursively()
        }
    }

    @Test
    fun manualEnqueueReportsStorageFailure() {
        val parent = Files.createTempDirectory("kinic-manual-storage-test").toFile()
        try {
            val queuePath = File(parent, "queue").apply { writeText("not a directory") }
            val result = enqueueManualCapture(
                ShareInbox(queuePath),
                "https://example.com/page",
                "db_demo",
                WikiOutputLanguage.ENGLISH,
            )

            assertFalse(result.isSuccess)
        } finally {
            parent.deleteRecursively()
        }
    }

    @Test
    fun concurrentSubmissionIsSingleFlight() = runTest {
        val entered = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        var calls = 0
        val coordinator = CaptureSubmissionCoordinator { _, _ ->
            calls += 1
            entered.complete(Unit)
            release.await()
            "Submitted."
        }
        val session = testCaptureSession()

        val first = async { coordinator.submitNext(session, null) }
        entered.await()
        val second = async { coordinator.submitNext(session, null) }

        assertNull(second.await())
        release.complete(Unit)
        assertEquals("Submitted.", first.await())
        assertEquals(1, calls)
    }
}

private fun testCaptureSession(): IcAuthSession {
    val configuration = testAppConfiguration().icClientConfiguration()
    val privateKey = IcIdentityBridge.generateSessionPrivateKey()
    return IcIdentityBridge.makeSession(
        identityPayload(privateKey, configuration.canisterId),
        privateKey,
        configuration,
    )
}
