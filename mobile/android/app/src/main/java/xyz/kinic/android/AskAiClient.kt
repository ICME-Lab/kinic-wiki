package xyz.kinic.android

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URI

interface AskAiCompleting {
    suspend fun completeContent(message: String, timeoutMilliseconds: Long): String
}

sealed class AskAiClientError(message: String) : Exception(message) {
    data object InvalidResponse : AskAiClientError("The AI service returned an invalid response.")
    data object IncompleteStream : AskAiClientError("The AI response ended before completion.")
    data object TruncatedResponse : AskAiClientError("The AI response reached its length limit.")
    data object ContentFiltered : AskAiClientError("The AI response was blocked by a content filter.")
    data object ResponseTooLarge : AskAiClientError("The AI response exceeded 128 KiB.")
    data object Timeout : AskAiClientError("The AI request timed out.")
    data class Http(val status: Int, val responseMessage: String) :
        AskAiClientError("AI service HTTP $status: $responseMessage")
}

class AskAiClient(private val endpoint: URI) : AskAiCompleting {
    override suspend fun completeContent(message: String, timeoutMilliseconds: Long): String =
        try {
            withTimeout(timeoutMilliseconds) {
                withContext(Dispatchers.IO) {
                    val connection = endpoint.toURL().openConnection() as HttpURLConnection
                    try {
                        connection.requestMethod = "POST"
                        connection.connectTimeout = timeoutMilliseconds.coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
                        connection.readTimeout = timeoutMilliseconds.coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
                        connection.setRequestProperty("content-type", "application/json")
                        connection.doOutput = true
                        connection.outputStream.use {
                            it.write(JSONObject().put("message", message).toString().toByteArray(Charsets.UTF_8))
                        }
                        val status = connection.responseCode
                        val expectedLength = connection.contentLengthLong
                        if (expectedLength > MAXIMUM_RESPONSE_BYTES) throw AskAiClientError.ResponseTooLarge
                        val stream = if (status in 200..299) connection.inputStream else connection.errorStream
                        val body = stream?.use(::readBounded) ?: byteArrayOf()
                        if (status !in 200..299) {
                            throw AskAiClientError.Http(status, body.toString(Charsets.UTF_8))
                        }
                        parseSse(body.toString(Charsets.UTF_8))
                    } finally {
                        connection.disconnect()
                    }
                }
            }
        } catch (_: kotlinx.coroutines.TimeoutCancellationException) {
            throw AskAiClientError.Timeout
        }

    private fun readBounded(input: java.io.InputStream): ByteArray {
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(8 * 1024)
        while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            if (output.size() + count > MAXIMUM_RESPONSE_BYTES) throw AskAiClientError.ResponseTooLarge
            output.write(buffer, 0, count)
        }
        return output.toByteArray()
    }

    companion object {
        const val MAXIMUM_RESPONSE_BYTES = 128 * 1024

        fun parseSse(body: String): String {
            val normalized = body.replace("\r\n", "\n").replace('\r', '\n')
            val usesBoundaries = "\n\n" in normalized
            var content = ""
            var receivedEvent = false
            var reachedCompletion = false
            var receivedDone = false
            val pending = mutableListOf<String>()

            fun process(payloadValue: String) {
                val payload = payloadValue.trim()
                receivedEvent = true
                if (payload == "[DONE]") {
                    if (receivedDone) throw AskAiClientError.InvalidResponse
                    receivedDone = true
                    reachedCompletion = true
                    return
                }
                if (reachedCompletion) throw AskAiClientError.InvalidResponse
                val event = runCatching { JSONObject(payload) }
                    .getOrElse { throw AskAiClientError.InvalidResponse }
                val chunk = event.optString("content").takeIf { event.has("content") && !event.isNull("content") }
                if (chunk != null) {
                    content += chunk
                    if (content.toByteArray(Charsets.UTF_8).size > MAXIMUM_RESPONSE_BYTES) {
                        throw AskAiClientError.ResponseTooLarge
                    }
                }
                if (event.has("finish_reason") && !event.isNull("finish_reason")) {
                    when (event.getString("finish_reason")) {
                        "stop" -> reachedCompletion = true
                        "length" -> throw AskAiClientError.TruncatedResponse
                        "content_filter" -> throw AskAiClientError.ContentFiltered
                        else -> throw AskAiClientError.InvalidResponse
                    }
                } else if (chunk == null) {
                    throw AskAiClientError.InvalidResponse
                }
            }

            fun dispatch() {
                if (pending.isEmpty()) return
                process(pending.joinToString("\n"))
                pending.clear()
            }

            normalized.split('\n').forEach { line ->
                if (line.isEmpty()) {
                    if (usesBoundaries) dispatch()
                } else if (!line.startsWith(":")) {
                    val field = line.substringBefore(':')
                    val rawValue = line.substringAfter(':', "")
                    val value = rawValue.removePrefix(" ")
                    if (field == "data") {
                        if (usesBoundaries) pending += value else process(value)
                    }
                }
            }
            if (usesBoundaries) dispatch()
            if (!receivedEvent || content.isEmpty()) throw AskAiClientError.InvalidResponse
            if (!reachedCompletion) throw AskAiClientError.IncompleteStream
            return content
        }
    }
}
