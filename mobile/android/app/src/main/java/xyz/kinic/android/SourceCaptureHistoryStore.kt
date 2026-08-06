package xyz.kinic.android

import org.json.JSONObject
import java.io.File
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.StandardCopyOption

class SourceCaptureHistoryStore(
    private val rootDirectory: File,
) {
    init {
        rootDirectory.mkdirs()
    }

    fun load(databaseId: String): List<SourceCaptureHistoryRecord> {
        val directory = databaseDirectory(databaseId) ?: return emptyList()
        return directory.listFiles { file -> file.extension == "json" }
            ?.mapNotNull(::decode)
            ?.filter { it.databaseId == databaseId }
            ?.sortedWith(
                compareByDescending<SourceCaptureHistoryRecord> { it.item.requestedAtMilliseconds }
                    .thenByDescending { it.item.requestPath },
            )
            ?.take(MAX_RECORDS_PER_DATABASE)
            ?: emptyList()
    }

    fun save(record: SourceCaptureHistoryRecord) {
        val directory = databaseDirectory(record.databaseId)
            ?: throw IllegalArgumentException("Invalid source capture history database.")
        val requestId = requestId(record.item.requestPath)
            ?: throw IllegalArgumentException("Invalid source capture history request.")
        directory.mkdirs()
        atomicWrite(File(directory, "$requestId.json"), encode(record).toString())
        prune(record.databaseId, directory)
    }

    private fun prune(databaseId: String, directory: File) {
        val keep = load(databaseId).mapTo(mutableSetOf()) { requestId(it.item.requestPath) }
        directory.listFiles { file -> file.extension == "json" }
            ?.filter { it.nameWithoutExtension !in keep }
            ?.forEach(File::delete)
    }

    private fun databaseDirectory(databaseId: String): File? =
        databaseId.takeIf(SourceCaptureRequestBuilder::isSafeStorageSegment)?.let {
            File(rootDirectory, it)
        }

    private fun decode(file: File): SourceCaptureHistoryRecord? =
        runCatching {
            val json = JSONObject(file.readText(Charsets.UTF_8))
            val itemJson = json.getJSONObject("item")
            val record = SourceCaptureHistoryRecord(
                databaseId = json.getString("databaseId"),
                item = SourceCaptureHistoryItem(
                    requestPath = itemJson.getString("requestPath"),
                    url = itemJson.getString("url"),
                    status = SourceCaptureHistoryStatus.valueOf(itemJson.getString("status")),
                    requestedAtMilliseconds = itemJson.getLong("requestedAtMilliseconds"),
                    updatedAtMilliseconds = itemJson.getLong("updatedAtMilliseconds"),
                    claimedAt = itemJson.nullableString("claimedAt"),
                    sourcePath = itemJson.nullableString("sourcePath"),
                    targetPath = itemJson.nullableString("targetPath"),
                    finishedAt = itemJson.nullableString("finishedAt"),
                    error = itemJson.nullableString("error"),
                    lastCheckedAtMilliseconds = itemJson.nullableLong("lastCheckedAtMilliseconds"),
                    syncError = itemJson.nullableString("syncError"),
                ),
            )
            if (file.nameWithoutExtension != requestId(record.item.requestPath)) return null
            record
        }.getOrNull()

    private fun encode(record: SourceCaptureHistoryRecord): JSONObject =
        JSONObject()
            .put("databaseId", record.databaseId)
            .put(
                "item",
                JSONObject()
                    .put("requestPath", record.item.requestPath)
                    .put("url", record.item.url)
                    .put("status", record.item.status.name)
                    .put("requestedAtMilliseconds", record.item.requestedAtMilliseconds)
                    .put("updatedAtMilliseconds", record.item.updatedAtMilliseconds)
                    .putNullable("claimedAt", record.item.claimedAt)
                    .putNullable("sourcePath", record.item.sourcePath)
                    .putNullable("targetPath", record.item.targetPath)
                    .putNullable("finishedAt", record.item.finishedAt)
                    .putNullable("error", record.item.error)
                    .putNullable("lastCheckedAtMilliseconds", record.item.lastCheckedAtMilliseconds)
                    .putNullable("syncError", record.item.syncError),
            )

    private fun atomicWrite(file: File, value: String) {
        val temporary = File(file.parentFile, "${file.name}.tmp")
        temporary.writeText(value, Charsets.UTF_8)
        try {
            Files.move(
                temporary.toPath(),
                file.toPath(),
                StandardCopyOption.ATOMIC_MOVE,
                StandardCopyOption.REPLACE_EXISTING,
            )
        } catch (_: AtomicMoveNotSupportedException) {
            Files.move(temporary.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING)
        }
    }

    companion object {
        const val MAX_RECORDS_PER_DATABASE = 100
        private const val REQUEST_PREFIX = "/Sources/source-capture-requests/"
        private const val REQUEST_SUFFIX = ".md"

        fun requestId(requestPath: String): String? {
            if (!requestPath.startsWith(REQUEST_PREFIX) || !requestPath.endsWith(REQUEST_SUFFIX)) return null
            val requestId = requestPath.removePrefix(REQUEST_PREFIX).removeSuffix(REQUEST_SUFFIX)
            return requestId.takeIf(SourceCaptureRequestBuilder::isSafeStorageSegment)
        }
    }
}

private fun JSONObject.putNullable(key: String, value: Any?): JSONObject =
    put(key, value ?: JSONObject.NULL)

private fun JSONObject.nullableString(key: String): String? =
    if (isNull(key)) null else getString(key)

private fun JSONObject.nullableLong(key: String): Long? =
    if (isNull(key)) null else getLong(key)

fun sourceCaptureHistoryStore(filesDir: File): SourceCaptureHistoryStore =
    SourceCaptureHistoryStore(File(filesDir, "source-capture-history.v1"))
