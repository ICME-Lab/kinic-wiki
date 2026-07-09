// Where: mobile/android/app/src/main/java/xyz/kinic/android/KinicSettingsStore.kt
// What: App-private Android settings for selected capture and browse databases.
// Why: Source capture and Browse should reuse the same database selection across launches.

package xyz.kinic.android

import org.json.JSONObject
import java.io.File

class KinicSettingsStore(
    private val file: File,
) {
    var selectedDatabaseId: String
        get() = read().optString("selectedDatabaseId").trim()
        set(value) = write(read().put("selectedDatabaseId", value.trim()))

    var selectedBrowseDatabaseId: String
        get() = read().optString("selectedBrowseDatabaseId").trim()
        set(value) = write(read().put("selectedBrowseDatabaseId", value.trim()))

    private fun read(): JSONObject =
        runCatching {
            JSONObject(file.readText(Charsets.UTF_8))
        }.getOrElse {
            JSONObject()
        }

    private fun write(json: JSONObject) {
        file.parentFile?.mkdirs()
        file.writeText(json.toString(), Charsets.UTF_8)
    }
}

fun kinicSettingsStore(filesDir: File): KinicSettingsStore =
    KinicSettingsStore(File(filesDir, "kinic-settings.json"))

