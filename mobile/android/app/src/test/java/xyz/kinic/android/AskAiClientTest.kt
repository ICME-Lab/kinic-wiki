package xyz.kinic.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class AskAiClientTest {
    @Test
    fun parsesCompleteSseWithoutPublishingPartialContent() {
        val body = """
            data: {"content":"<answer>"}

            data: {"content":"grounded"}

            data: {"content":"</answer>","finish_reason":"stop"}

        """.trimIndent()

        assertEquals("<answer>grounded</answer>", AskAiClient.parseSse(body))
    }

    @Test
    fun acceptsDoneMarkerAndNormalizesCrlf() {
        val body = "data: {\"content\":\"complete\"}\r\n\r\ndata: [DONE]\r\n"

        assertEquals("complete", AskAiClient.parseSse(body))
    }

    @Test
    fun rejectsIncompleteLengthAndFilteredStreams() {
        assertThrows(AskAiClientError.IncompleteStream::class.java) {
            AskAiClient.parseSse("data: {\"content\":\"partial\"}\n")
        }
        assertThrows(AskAiClientError.TruncatedResponse::class.java) {
            AskAiClient.parseSse("data: {\"content\":\"partial\",\"finish_reason\":\"length\"}\n")
        }
        assertThrows(AskAiClientError.ContentFiltered::class.java) {
            AskAiClient.parseSse("data: {\"content\":\"partial\",\"finish_reason\":\"content_filter\"}\n")
        }
    }

    @Test
    fun rejectsEventsAfterCompletion() {
        assertThrows(AskAiClientError.InvalidResponse::class.java) {
            AskAiClient.parseSse(
                "data: {\"content\":\"done\",\"finish_reason\":\"stop\"}\n" +
                    "data: {\"content\":\"late\"}\n",
            )
        }
    }
}
