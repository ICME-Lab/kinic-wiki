// Where: mobile/android/app/src/main/java/xyz/kinic/android/KinicSettingsStore.kt
// What: App-private Android settings for selected capture and browse databases.
// Why: Source capture and Browse should reuse the same database selection across launches.

package xyz.kinic.android

import org.json.JSONObject
import java.io.File
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.StandardCopyOption

class KinicSettingsStore(
    private val file: File,
) {
    var selectedDatabaseId: String
        get() = read().optString("selectedDatabaseId").trim()
        set(value) = write(read().put("selectedDatabaseId", value.trim()))

    var selectedBrowseDatabaseId: String
        get() = read().optString("selectedBrowseDatabaseId").trim()
        set(value) = write(read().put("selectedBrowseDatabaseId", value.trim()))

    var showPublicDatabases: Boolean
        get() = read().optBoolean("showPublicDatabases", true)
        set(value) = write(read().put("showPublicDatabases", value))

    var showPurchasedDatabases: Boolean
        get() = read().optBoolean("showPurchasedDatabases", false)
        set(value) = write(read().put("showPurchasedDatabases", value))

    var darkMode: DarkMode
        get() = runCatching {
            DarkMode.valueOf(read().optString("darkMode", DarkMode.SYSTEM.name))
        }.getOrDefault(DarkMode.SYSTEM)
        set(value) = write(read().put("darkMode", value.name))

    var generationLanguage: WikiOutputLanguage
        get() = WikiOutputLanguage.fromSetting(read().optString("generationLanguage", WikiOutputLanguage.ENGLISH.code))
        set(value) = write(read().put("generationLanguage", value.code))

    private fun read(): JSONObject =
        runCatching {
            JSONObject(file.readText(Charsets.UTF_8))
        }.getOrElse {
            JSONObject()
        }

    private fun write(json: JSONObject) {
        file.parentFile?.mkdirs()
        val temporary = File(file.parentFile, "${file.name}.tmp")
        temporary.writeText(json.toString(), Charsets.UTF_8)
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
}

enum class DarkMode {
    SYSTEM,
    LIGHT,
    DARK,
}

fun kinicSettingsStore(filesDir: File): KinicSettingsStore =
    KinicSettingsStore(File(filesDir, "kinic-settings.json"))
