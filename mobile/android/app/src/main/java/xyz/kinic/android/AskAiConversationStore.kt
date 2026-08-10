package xyz.kinic.android

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.time.Instant

class AskAiConversationStore(
    private val file: File,
    private val corruptDirectory: File,
) {
    fun load(): List<AskAiConversation> {
        if (!file.exists()) return emptyList()
        val array = JSONArray(file.readText(Charsets.UTF_8))
        return (0 until array.length()).map { decodeConversation(array.getJSONObject(it)) }
            .sortedByDescending(AskAiConversation::updatedAt)
    }

    fun hasStoredData(): Boolean =
        file.exists() || corruptDirectory.listFiles()?.any { it.name.startsWith(archivePrefix()) } == true

    fun save(conversations: List<AskAiConversation>) {
        file.parentFile?.mkdirs()
        val array = JSONArray()
        conversations.forEach { array.put(encodeConversation(it)) }
        atomicWrite(file, array.toString())
    }

    fun resetAfterLoadFailure() {
        if (!file.exists()) return
        corruptDirectory.mkdirs()
        val archive = File(
            corruptDirectory,
            "${archivePrefix()}${System.currentTimeMillis()}-${java.util.UUID.randomUUID()}.json",
        )
        Files.move(file.toPath(), archive.toPath(), StandardCopyOption.REPLACE_EXISTING)
    }

    fun deleteAllStoredData() {
        file.delete()
        corruptDirectory.listFiles()
            ?.filter { it.name.startsWith(archivePrefix()) }
            ?.forEach(File::delete)
    }

    private fun archivePrefix(): String =
        "${file.parentFile?.name}-conversations-v1.corrupt-"

    private fun decodeConversation(json: JSONObject): AskAiConversation =
        AskAiConversation(
            id = json.getString("id"),
            databaseId = json.getString("databaseId"),
            databaseTitle = json.getString("databaseTitle"),
            title = json.getString("title"),
            messages = json.getJSONArray("messages").let { messages ->
                (0 until messages.length()).map { decodeMessage(messages.getJSONObject(it)) }
            },
            createdAt = Instant.parse(json.getString("createdAt")),
            updatedAt = Instant.parse(json.getString("updatedAt")),
        )

    private fun decodeMessage(json: JSONObject): AskAiMessage =
        AskAiMessage(
            id = json.getString("id"),
            role = AskAiMessageRole.valueOf(json.getString("role")),
            text = json.getString("text"),
            state = AskAiMessageState.valueOf(json.getString("state")),
            sources = json.getJSONArray("sources").let { sources ->
                (0 until sources.length()).map { decodeSource(sources.getJSONObject(it)) }
            },
            trace = json.getJSONArray("trace").let { trace ->
                (0 until trace.length()).map { decodeTrace(trace.getJSONObject(it)) }
            },
            createdAt = Instant.parse(json.getString("createdAt")),
        )

    private fun decodeSource(json: JSONObject): AskAiSource =
        AskAiSource(
            id = json.getString("id"),
            path = json.getString("path"),
            excerpt = json.getString("excerpt"),
            score = json.getDouble("score").toFloat(),
            matchReasons = json.getJSONArray("matchReasons").let { reasons ->
                (0 until reasons.length()).map(reasons::getString)
            },
        )

    private fun decodeTrace(json: JSONObject): AskAiTraceEvent =
        AskAiTraceEvent(
            id = json.getString("id"),
            stage = AskAiTraceStage.valueOf(json.getString("stage")),
            title = json.getString("title"),
            detail = json.optString("detail").takeIf { json.has("detail") && !json.isNull("detail") },
            isActive = false,
        )

    private fun encodeConversation(value: AskAiConversation): JSONObject =
        JSONObject()
            .put("id", value.id)
            .put("databaseId", value.databaseId)
            .put("databaseTitle", value.databaseTitle)
            .put("title", value.title)
            .put("messages", JSONArray().also { array -> value.messages.forEach { array.put(encodeMessage(it)) } })
            .put("createdAt", value.createdAt.toString())
            .put("updatedAt", value.updatedAt.toString())

    private fun encodeMessage(value: AskAiMessage): JSONObject =
        JSONObject()
            .put("id", value.id)
            .put("role", value.role.name)
            .put("text", value.text)
            .put("state", value.state.name)
            .put("sources", JSONArray().also { array -> value.sources.forEach { array.put(encodeSource(it)) } })
            .put("trace", JSONArray().also { array -> value.trace.forEach { array.put(encodeTrace(it)) } })
            .put("createdAt", value.createdAt.toString())

    private fun encodeSource(value: AskAiSource): JSONObject =
        JSONObject()
            .put("id", value.id)
            .put("path", value.path)
            .put("excerpt", value.excerpt)
            .put("score", value.score.toDouble())
            .put("matchReasons", JSONArray(value.matchReasons))

    private fun encodeTrace(value: AskAiTraceEvent): JSONObject =
        JSONObject()
            .put("id", value.id)
            .put("stage", value.stage.name)
            .put("title", value.title)
            .put("detail", value.detail ?: JSONObject.NULL)
            .put("isActive", false)

    private fun atomicWrite(target: File, value: String) {
        val temporary = File(target.parentFile, "${target.name}.tmp")
        temporary.writeText(value, Charsets.UTF_8)
        try {
            Files.move(
                temporary.toPath(),
                target.toPath(),
                StandardCopyOption.ATOMIC_MOVE,
                StandardCopyOption.REPLACE_EXISTING,
            )
        } catch (_: AtomicMoveNotSupportedException) {
            Files.move(temporary.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING)
        }
    }
}

class AskAiConversationStoreFactory(private val filesDirectory: File) {
    fun create(principal: String?): AskAiConversationStore {
        val scope = principal?.let {
            "principal-" + MessageDigest.getInstance("SHA-256")
                .digest(it.toByteArray(Charsets.UTF_8))
                .joinToString("") { byte -> "%02x".format(byte) }
        } ?: "guest"
        val root = File(filesDirectory, "ask-ai")
        return AskAiConversationStore(
            File(File(root, scope), "conversations-v1.json"),
            File(root, "Corrupt"),
        )
    }
}
