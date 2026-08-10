// Where: mobile/android/app/src/main/java/xyz/kinic/android/JsonStrings.kt
// What: Small JSON string helpers for deterministic request metadata.
// Why: Source capture metadata needs stable JSON without adding a broad serialization stack.

package xyz.kinic.android

internal fun jsonString(value: String): String {
    val out = StringBuilder(value.length + 2)
    out.append('"')
    for (char in value) {
        when (char) {
            '"' -> out.append("\\\"")
            '\\' -> out.append("\\\\")
            '/' -> out.append("\\/")
            '\b' -> out.append("\\b")
            '\u000C' -> out.append("\\f")
            '\n' -> out.append("\\n")
            '\r' -> out.append("\\r")
            '\t' -> out.append("\\t")
            else -> {
                if (char.code < 0x20) {
                    out.append("\\u")
                    out.append(char.code.toString(16).padStart(4, '0'))
                } else {
                    out.append(char)
                }
            }
        }
    }
    out.append('"')
    return out.toString()
}

internal fun jsonObjectSorted(values: Map<String, String>): String =
    values.toSortedMap().entries.joinToString(
        separator = ",",
        prefix = "{",
        postfix = "}",
    ) { (key, value) -> "${jsonString(key)}:${jsonString(value)}" }
