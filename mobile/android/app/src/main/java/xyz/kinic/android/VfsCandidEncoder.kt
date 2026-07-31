// Where: mobile/android/app/src/main/java/xyz/kinic/android/VfsCandidEncoder.kt
// What: Minimal Candid encoder for Android source capture methods.
// Why: The first Android port needs explicit, testable VFS wire shapes without broad IC dependencies.

package xyz.kinic.android

object VfsCandidEncoder {
    private val magic = listOf(0x44, 0x49, 0x44, 0x4c).map(Int::toByte)
    private const val typeNull = -1L
    private const val typeBool = -2L
    private const val typeNat32 = -7L
    private const val typeNat64 = -8L
    private const val typeText = -15L
    private const val typeOpt = -18L
    private const val typeVec = -19L
    private const val typeRecord = -20L
    private const val typeVariant = -21L

    fun empty(): ByteArray {
        val out = mutableListOf<Byte>()
        out += magic
        appendUnsigned(0uL, out)
        appendUnsigned(0uL, out)
        return out.toByteArray()
    }

    fun readNode(databaseId: String, path: String): ByteArray =
        textArgs(listOf(databaseId, path))

    fun textArgsForDatabase(databaseId: String): ByteArray =
        textArgs(listOf(databaseId))

    fun listChildren(databaseId: String, path: String): ByteArray =
        oneRecord(
            tableEntries = listOf(
                TypeEntry.Record(
                    listOf(
                        field("path", TypeRef.Primitive(typeText)),
                        field("database_id", TypeRef.Primitive(typeText)),
                    ),
                ),
            ),
            argType = TypeRef.Table(0),
            namedValues = listOf(
                "path" to Value.Text(path),
                "database_id" to Value.Text(databaseId),
            ),
        )

    fun searchNodes(databaseId: String, query: String, prefix: String?, topK: UInt): ByteArray {
        val optionalText = TypeEntry.Opt(TypeRef.Primitive(typeText))
        val previewMode = TypeEntry.Variant(
            listOf(
                field("Light", TypeRef.Primitive(typeNull)),
                field("ContentStart", TypeRef.Primitive(typeNull)),
                field("None", TypeRef.Primitive(typeNull)),
            ),
        )
        val optionalPreviewMode = TypeEntry.Opt(TypeRef.Table(1))
        val request = TypeEntry.Record(
            listOf(
                field("top_k", TypeRef.Primitive(typeNat32)),
                field("database_id", TypeRef.Primitive(typeText)),
                field("preview_mode", TypeRef.Table(2)),
                field("prefix", TypeRef.Table(0)),
                field("query_text", TypeRef.Primitive(typeText)),
            ),
        )
        return oneRecord(
            tableEntries = listOf(optionalText, previewMode, optionalPreviewMode, request),
            argType = TypeRef.Table(3),
            namedValues = listOf(
                "top_k" to Value.Nat32(topK),
                "database_id" to Value.Text(databaseId),
                "preview_mode" to Value.Some(
                    Value.Variant("Light", listOf("Light", "ContentStart", "None"), Value.Null),
                ),
                "prefix" to (prefix?.let { Value.Some(Value.Text(it)) } ?: Value.None),
                "query_text" to Value.Text(query),
            ),
        )
    }

    fun createDatabase(name: String): ByteArray =
        oneRecord(
            tableEntries = listOf(
                TypeEntry.Record(listOf(field("name", TypeRef.Primitive(typeText)))),
            ),
            argType = TypeRef.Table(0),
            namedValues = listOf("name" to Value.Text(name)),
        )

    fun updateDatabaseMetadata(
        databaseId: String,
        name: String,
        description: String,
        llmSummary: String?,
        tagsJson: String,
    ): ByteArray {
        val optionalText = TypeEntry.Opt(TypeRef.Primitive(typeText))
        val request = TypeEntry.Record(
            listOf(
                field("llm_summary", TypeRef.Table(0)),
                field("name", TypeRef.Primitive(typeText)),
                field("description", TypeRef.Primitive(typeText)),
                field("database_id", TypeRef.Primitive(typeText)),
                field("tags_json", TypeRef.Primitive(typeText)),
            ),
        )
        return oneRecord(
            tableEntries = listOf(optionalText, request),
            argType = TypeRef.Table(1),
            namedValues = listOf(
                "llm_summary" to (llmSummary?.let { Value.Some(Value.Text(it)) } ?: Value.None),
                "name" to Value.Text(name),
                "description" to Value.Text(description),
                "database_id" to Value.Text(databaseId),
                "tags_json" to Value.Text(tagsJson),
            ),
        )
    }

    fun grantDatabaseAccess(databaseId: String, principal: String, role: DatabaseRole): ByteArray {
        val roles = listOf("Owner", "Writer", "Reader")
        val roleVariant = TypeEntry.Variant(
            roles.map { field(it, TypeRef.Primitive(typeNull)) },
        )
        return encodeArguments(
            tableEntries = listOf(roleVariant),
            argumentTypes = listOf(
                TypeRef.Primitive(typeText),
                TypeRef.Primitive(typeText),
                TypeRef.Table(0),
            ),
            values = listOf(
                Value.Text(databaseId),
                Value.Text(principal),
                Value.Variant(role.candidName, roles, Value.Null),
            ),
        )
    }

    fun revokeDatabaseAccess(databaseId: String, principal: String): ByteArray =
        textArgs(listOf(databaseId, principal))

    fun listDatabaseCycleEntries(databaseId: String, cursor: ULong?, limit: UInt): ByteArray =
        encodeArguments(
            tableEntries = listOf(TypeEntry.Opt(TypeRef.Primitive(typeNat64))),
            argumentTypes = listOf(
                TypeRef.Primitive(typeText),
                TypeRef.Table(0),
                TypeRef.Primitive(typeNat32),
            ),
            values = listOf(
                Value.Text(databaseId),
                cursor?.let { Value.Some(Value.Nat64(it)) } ?: Value.None,
                Value.Nat32(limit),
            ),
        )

    fun marketListEntitlements(cursor: String?, limit: UInt): ByteArray =
        encodeArguments(
            tableEntries = listOf(TypeEntry.Opt(TypeRef.Primitive(typeText))),
            argumentTypes = listOf(TypeRef.Table(0), TypeRef.Primitive(typeNat32)),
            values = listOf(
                cursor?.let { Value.Some(Value.Text(it)) } ?: Value.None,
                Value.Nat32(limit),
            ),
        )

    fun deleteDatabase(databaseId: String): ByteArray =
        oneRecord(
            tableEntries = listOf(
                TypeEntry.Record(listOf(field("database_id", TypeRef.Primitive(typeText)))),
            ),
            argType = TypeRef.Table(0),
            namedValues = listOf("database_id" to Value.Text(databaseId)),
        )

    fun authorizeSourceCaptureTriggerSession(databaseId: String, sessionNonce: String): ByteArray =
        encodeRecordValues(
            tableEntries = listOf(
                TypeEntry.Record(
                    listOf(
                        field("database_id", TypeRef.Primitive(typeText)),
                        field("session_nonce", TypeRef.Primitive(typeText)),
                    ),
                ),
            ),
            argType = TypeRef.Table(0),
            values = listOf(
                Value.Text(sessionNonce),
                Value.Text(databaseId),
            ),
        )

    fun writeNodes(request: SourceCaptureRequest): ByteArray {
        val nodeKind = TypeEntry.Variant(
            listOf(
                field("File", TypeRef.Primitive(typeNull)),
                field("Source", TypeRef.Primitive(typeNull)),
                field("Folder", TypeRef.Primitive(typeNull)),
            ),
        )
        val optionalText = TypeEntry.Opt(TypeRef.Primitive(typeText))
        val writeNodeItem = TypeEntry.Record(
            listOf(
                field("content", TypeRef.Primitive(typeText)),
                field("kind", TypeRef.Table(0)),
                field("path", TypeRef.Primitive(typeText)),
                field("expected_etag", TypeRef.Table(1)),
                field("metadata_json", TypeRef.Primitive(typeText)),
            ),
        )
        val writeNodeItems = TypeEntry.Vec(TypeRef.Table(2))
        val writeNodesRequest = TypeEntry.Record(
            listOf(
                field("nodes", TypeRef.Table(3)),
                field("database_id", TypeRef.Primitive(typeText)),
            ),
        )
        return oneRecord(
            tableEntries = listOf(nodeKind, optionalText, writeNodeItem, writeNodeItems, writeNodesRequest),
            argType = TypeRef.Table(4),
            namedValues = listOf(
                "nodes" to Value.Vector(
                    listOf(
                        Value.Record(
                            listOf(
                                "content" to Value.Text(request.content),
                                "kind" to Value.Variant("File", listOf("File", "Source", "Folder"), Value.Null),
                                "path" to Value.Text(request.requestPath),
                                "expected_etag" to Value.None,
                                "metadata_json" to Value.Text(request.metadataJson),
                            ),
                        ),
                    ),
                ),
                "database_id" to Value.Text(request.databaseId),
            ),
        )
    }

    private fun oneRecord(
        tableEntries: List<TypeEntry>,
        argType: TypeRef,
        namedValues: List<Pair<String, Value>>,
    ): ByteArray =
        encodeRecordValues(
            tableEntries = tableEntries,
            argType = argType,
            values = namedValues.sortedBy { label(it.first) }.map { it.second },
        )

    private fun encodeRecordValues(tableEntries: List<TypeEntry>, argType: TypeRef, values: List<Value>): ByteArray {
        val out = mutableListOf<Byte>()
        out += magic
        appendUnsigned(tableEntries.size.toULong(), out)
        tableEntries.forEach { encode(it, out) }
        appendUnsigned(1uL, out)
        encode(argType, out)
        values.forEach { encode(it, out) }
        return out.toByteArray()
    }

    private fun encodeArguments(
        tableEntries: List<TypeEntry>,
        argumentTypes: List<TypeRef>,
        values: List<Value>,
    ): ByteArray {
        require(argumentTypes.size == values.size)
        val out = mutableListOf<Byte>()
        out += magic
        appendUnsigned(tableEntries.size.toULong(), out)
        tableEntries.forEach { encode(it, out) }
        appendUnsigned(argumentTypes.size.toULong(), out)
        argumentTypes.forEach { encode(it, out) }
        values.forEach { encode(it, out) }
        return out.toByteArray()
    }

    private fun textArgs(texts: List<String>): ByteArray {
        val out = mutableListOf<Byte>()
        out += magic
        appendUnsigned(0uL, out)
        appendUnsigned(texts.size.toULong(), out)
        repeat(texts.size) { appendSigned(typeText, out) }
        texts.forEach { appendText(it, out) }
        return out.toByteArray()
    }

    private fun field(name: String, type: TypeRef): Field =
        Field(id = label(name), name = name, type = type)

    private fun label(name: String): UInt =
        VfsCandidLabels.id(name)

    private fun encode(entry: TypeEntry, out: MutableList<Byte>) {
        when (entry) {
            is TypeEntry.Record -> {
                appendSigned(typeRecord, out)
                val fields = entry.fields.sortedBy { it.id }
                appendUnsigned(fields.size.toULong(), out)
                fields.forEach {
                    appendUnsigned(it.id.toULong(), out)
                    encode(it.type, out)
                }
            }
            is TypeEntry.Variant -> {
                appendSigned(typeVariant, out)
                val fields = entry.fields.sortedBy { it.id }
                appendUnsigned(fields.size.toULong(), out)
                fields.forEach {
                    appendUnsigned(it.id.toULong(), out)
                    encode(it.type, out)
                }
            }
            is TypeEntry.Opt -> {
                appendSigned(typeOpt, out)
                encode(entry.type, out)
            }
            is TypeEntry.Vec -> {
                appendSigned(typeVec, out)
                encode(entry.type, out)
            }
        }
    }

    private fun encode(type: TypeRef, out: MutableList<Byte>) {
        when (type) {
            is TypeRef.Primitive -> appendSigned(type.value, out)
            is TypeRef.Table -> appendSigned(type.index, out)
        }
    }

    private fun encode(value: Value, out: MutableList<Byte>) {
        when (value) {
            Value.Null -> Unit
            Value.None -> out += 0.toByte()
            is Value.Nat32 -> appendFixedUInt32(value.value, out)
            is Value.Nat64 -> appendFixedUInt64(value.value, out)
            is Value.Text -> appendText(value.text, out)
            is Value.Record -> value.fields.sortedBy { label(it.first) }.forEach { encode(it.second, out) }
            is Value.Vector -> {
                appendUnsigned(value.values.size.toULong(), out)
                value.values.forEach { encode(it, out) }
            }
            is Value.Variant -> {
                val index = value.cases.sortedBy(::label).indexOf(value.label).takeIf { it >= 0 } ?: 0
                appendUnsigned(index.toULong(), out)
                encode(value.inner, out)
            }
            is Value.Some -> {
                out += 1.toByte()
                encode(value.inner, out)
            }
        }
    }

    private fun appendText(text: String, out: MutableList<Byte>) {
        val bytes = text.encodeToByteArray()
        appendUnsigned(bytes.size.toULong(), out)
        out += bytes.toList()
    }

    private fun appendFixedUInt32(value: UInt, out: MutableList<Byte>) {
        repeat(4) { offset ->
            out += ((value shr (offset * 8)) and 0xffu).toByte()
        }
    }

    private fun appendFixedUInt64(value: ULong, out: MutableList<Byte>) {
        repeat(8) { offset ->
            out += ((value shr (offset * 8)) and 0xffu).toByte()
        }
    }

    private fun appendUnsigned(value: ULong, out: MutableList<Byte>) =
        VfsCandidLeb.appendUnsigned(value, out)

    private fun appendSigned(value: Long, out: MutableList<Byte>) =
        VfsCandidLeb.appendSigned(value, out)

    private data class Field(val id: UInt, val name: String, val type: TypeRef)

    private sealed class TypeRef {
        data class Primitive(val value: Long) : TypeRef()
        data class Table(val index: Long) : TypeRef()
    }

    private sealed class TypeEntry {
        data class Record(val fields: List<Field>) : TypeEntry()
        data class Variant(val fields: List<Field>) : TypeEntry()
        data class Opt(val type: TypeRef) : TypeEntry()
        data class Vec(val type: TypeRef) : TypeEntry()
    }

    private sealed class Value {
        data object Null : Value()
        data object None : Value()
        data class Nat32(val value: UInt) : Value()
        data class Nat64(val value: ULong) : Value()
        data class Text(val text: String) : Value()
        data class Record(val fields: List<Pair<String, Value>>) : Value()
        data class Vector(val values: List<Value>) : Value()
        data class Variant(val label: String, val cases: List<String>, val inner: Value) : Value()
        data class Some(val inner: Value) : Value()
    }
}
