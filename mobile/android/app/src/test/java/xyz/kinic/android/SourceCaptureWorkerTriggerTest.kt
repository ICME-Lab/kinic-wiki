package xyz.kinic.android

import com.sun.net.httpserver.HttpServer
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import java.net.InetSocketAddress
import java.net.URI

class SourceCaptureWorkerTriggerTest {
    @Test
    fun readTimeoutReturnsRetryableFailure() = runBlocking {
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/api/source-capture/trigger") { exchange ->
            Thread.sleep(250)
            runCatching { exchange.sendResponseHeaders(204, -1) }
            exchange.close()
        }
        server.start()
        try {
            val base = testAppConfiguration().copy(
                authOrigin = URI("http://127.0.0.1:${server.address.port}"),
            )
            val result = HttpSourceCaptureWorkerTrigger(base, timeoutMilliseconds = 50).trigger(
                TriggerSourceCaptureRequest("canister", "database", "/request.md", "nonce"),
            )

            assertFalse(result.accepted)
            assertEquals("worker trigger timed out", result.error)
        } finally {
            server.stop(0)
        }
    }
}
