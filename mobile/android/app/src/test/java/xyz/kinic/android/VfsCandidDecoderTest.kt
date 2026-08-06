// Where: mobile/android/app/src/test/java/xyz/kinic/android/VfsCandidDecoderTest.kt
// What: JVM fixtures for the Android Browse Candid decoder.
// Why: Browse relies on a narrow canister wire contract and should fail loudly on drift.

package xyz.kinic.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class VfsCandidDecoderTest {
    @Test
    fun decodesUnitResultOkNullAndRecord() {
        VfsCandidDecoder.decodeUnitResult(CandidFixture.unitOkNull())
        VfsCandidDecoder.decodeUnitResult(CandidFixture.unitOkRecord())
    }

    @Test
    fun unitResultErrBecomesException() {
        val error = assertThrows(VfsCandidError.CanisterRejected::class.java) {
            VfsCandidDecoder.decodeUnitResult(CandidFixture.errText("unit denied"))
        }

        assertEquals("unit denied", error.detail)
    }

    @Test
    fun decodesWriteNodesResultOkVectorRecord() {
        VfsCandidDecoder.decodeWriteNodesResult(CandidFixture.writeNodesOk())
    }

    @Test
    fun writeNodesResultErrBecomesException() {
        val error = assertThrows(VfsCandidError.CanisterRejected::class.java) {
            VfsCandidDecoder.decodeWriteNodesResult(CandidFixture.errText("write denied"))
        }

        assertEquals("write denied", error.detail)
    }

    @Test
    fun decodesDatabaseSummaries() {
        val databases = VfsCandidDecoder.decodeDatabaseSummaries(CandidFixture.databaseSummariesOk())

        assertEquals(3, databases.size)
        assertEquals("Reader Top", databases[0].title)
        assertEquals(DatabaseRole.READER, databases[0].role)
        assertTrue(databases[0].canRead)
        assertFalse(databases[0].canWrite)
        assertEquals("Writer Metadata", databases[1].title)
        assertEquals("Writer description", databases[1].description)
        assertEquals("Writer summary", databases[1].metadata?.llmSummary)
        assertEquals(DatabaseRole.WRITER, databases[1].role)
        assertTrue(databases[1].canWrite)
        assertEquals(DatabaseStatus.DELETED, databases[2].status)
        assertFalse(databases[2].canRead)
    }

    @Test
    fun filtersActiveReadableDatabasesForSelection() {
        val selectable = VfsCandidDecoder.decodeDatabaseSummaries(CandidFixture.databaseSummariesOk())
            .filter(DatabaseSummary::canRead)

        assertEquals(listOf("db_reader", "db_writer"), selectable.map { it.databaseId })
    }

    @Test
    fun decodesAndSortsChildNodes() {
        val children = VfsCandidDecoder.decodeChildNodesResult(CandidFixture.childNodesOk()).sortedBrowseChildren()

        assertEquals(listOf("Alpha", "beta", "zeta.md"), children.map { it.name })
        assertEquals(VfsNodeKind.FOLDER, children[0].kind)
        assertEquals(VfsNodeKind.FOLDER, children[1].kind)
        assertEquals(VfsNodeKind.FILE, children[2].kind)
    }

    @Test
    fun decodesReadNodeResult() {
        val node = VfsCandidDecoder.decodeReadNodeResult(CandidFixture.readNodeOk())

        assertEquals("/docs/readme.md", node?.path)
        assertEquals(VfsNodeKind.FILE, node?.kind)
        assertEquals("# Title", node?.content)
        assertEquals("{\"title\":\"Readme\"}", node?.metadataJson)
        assertEquals("etag-1", node?.etag)
        assertEquals(10L, node?.createdAt)
        assertEquals(20L, node?.updatedAt)
    }

    @Test
    fun decodesEmptyReadNodeResult() {
        assertNull(VfsCandidDecoder.decodeReadNodeResult(CandidFixture.readNodeNone()))
    }

    @Test
    fun canisterErrBecomesException() {
        val error = assertThrows(VfsCandidError.CanisterRejected::class.java) {
            VfsCandidDecoder.decodeChildNodesResult(CandidFixture.errText("denied"))
        }

        assertEquals("denied", error.detail)
    }
}

internal object CandidFixture {
    private val magic = listOf(0x44, 0x49, 0x44, 0x4c).map(Int::toByte)
    private const val typeNull = -1L
    private const val typeBool = -2L
    private const val typeNat64 = -8L
    private const val typeInt64 = -12L
    private const val typeText = -15L
    private const val typeOpt = -18L
    private const val typeVec = -19L
    private const val typeRecord = -20L
    private const val typeVariant = -21L

    fun unitOkNull(): ByteArray {
        val result = Entry.Variant(
            listOf(
                field("Ok", TypeRef.Primitive(typeNull)),
                field("Err", TypeRef.Primitive(typeText)),
            ),
        )
        return didl(
            entries = listOf(result),
            argType = TypeRef.Table(0),
            value = Value.Variant("Ok", Value.Null),
        )
    }

    fun unitOkRecord(): ByteArray {
        val record = Entry.Record(emptyList())
        val result = Entry.Variant(
            listOf(
                field("Ok", TypeRef.Table(0)),
                field("Err", TypeRef.Primitive(typeText)),
            ),
        )
        return didl(
            entries = listOf(record, result),
            argType = TypeRef.Table(1),
            value = Value.Variant("Ok", Value.Record(emptyMap())),
        )
    }

    fun writeNodesOk(): ByteArray {
        val record = Entry.Record(emptyList())
        val vector = Entry.Vec(TypeRef.Table(0))
        val result = Entry.Variant(
            listOf(
                field("Ok", TypeRef.Table(1)),
                field("Err", TypeRef.Primitive(typeText)),
            ),
        )
        return didl(
            entries = listOf(record, vector, result),
            argType = TypeRef.Table(2),
            value = Value.Variant("Ok", Value.Vector(listOf(Value.Record(emptyMap())))),
        )
    }

    fun databaseSummariesOk(): ByteArray {
        val optionalText = Entry.Opt(TypeRef.Primitive(typeText))
        val metadata = Entry.Record(
            listOf(
                field("name", TypeRef.Primitive(typeText)),
                field("description", TypeRef.Primitive(typeText)),
                field("llm_summary", TypeRef.Table(0)),
                field("tags_json", TypeRef.Primitive(typeText)),
            ),
        )
        val optionalMetadata = Entry.Opt(TypeRef.Table(1))
        val role = Entry.Variant(
            listOf(
                field("Reader", TypeRef.Primitive(typeNull)),
                field("Writer", TypeRef.Primitive(typeNull)),
                field("Owner", TypeRef.Primitive(typeNull)),
            ),
        )
        val status = Entry.Variant(
            listOf(
                field("Active", TypeRef.Primitive(typeNull)),
                field("Deleted", TypeRef.Primitive(typeNull)),
                field("Pending", TypeRef.Primitive(typeNull)),
            ),
        )
        val optionalNat64 = Entry.Opt(TypeRef.Primitive(typeNat64))
        val optionalInt64 = Entry.Opt(TypeRef.Primitive(typeInt64))
        val database = Entry.Record(
            listOf(
                field("database_id", TypeRef.Primitive(typeText)),
                field("name", TypeRef.Primitive(typeText)),
                field("metadata", TypeRef.Table(2)),
                field("role", TypeRef.Table(3)),
                field("status", TypeRef.Table(4)),
                field("logical_size_bytes", TypeRef.Primitive(typeNat64)),
                field("cycles_balance", TypeRef.Table(5)),
                field("cycles_suspended_at_ms", TypeRef.Table(6)),
                field("deleted_at_ms", TypeRef.Table(7)),
            ),
        )
        val databases = Entry.Vec(TypeRef.Table(8))
        val result = Entry.Variant(
            listOf(
                field("Ok", TypeRef.Table(9)),
                field("Err", TypeRef.Primitive(typeText)),
            ),
        )
        return didl(
            entries = listOf(optionalText, metadata, optionalMetadata, role, status, optionalNat64, optionalInt64, optionalInt64, database, databases, result),
            argType = TypeRef.Table(10),
            value = Value.Variant(
                "Ok",
                Value.Vector(
                    listOf(
                        database("db_reader", "Reader Top", "Reader", "Active", null),
                        database(
                            databaseId = "db_writer",
                            topLevelName = "Writer Top",
                            role = "Writer",
                            status = "Active",
                            metadata = metadataValue("Writer Metadata", "Writer description", "Writer summary"),
                        ),
                        database("db_deleted", "Deleted Top", "Owner", "Deleted", null),
                    ),
                ),
            ),
        )
    }

    fun childNodesOk(): ByteArray {
        val optionalInt64 = Entry.Opt(TypeRef.Primitive(typeInt64))
        val optionalText = Entry.Opt(TypeRef.Primitive(typeText))
        val optionalNat64 = Entry.Opt(TypeRef.Primitive(typeNat64))
        val kind = Entry.Variant(
            listOf(
                field("Folder", TypeRef.Primitive(typeNull)),
                field("File", TypeRef.Primitive(typeNull)),
                field("Source", TypeRef.Primitive(typeNull)),
                field("Directory", TypeRef.Primitive(typeNull)),
            ),
        )
        val child = Entry.Record(
            listOf(
                field("path", TypeRef.Primitive(typeText)),
                field("name", TypeRef.Primitive(typeText)),
                field("kind", TypeRef.Table(3)),
                field("updated_at", TypeRef.Table(0)),
                field("etag", TypeRef.Table(1)),
                field("size_bytes", TypeRef.Table(2)),
                field("has_children", TypeRef.Primitive(typeBool)),
                field("is_virtual", TypeRef.Primitive(typeBool)),
            ),
        )
        val children = Entry.Vec(TypeRef.Table(4))
        val result = Entry.Variant(
            listOf(
                field("Ok", TypeRef.Table(5)),
                field("Err", TypeRef.Primitive(typeText)),
            ),
        )
        return didl(
            entries = listOf(optionalInt64, optionalText, optionalNat64, kind, child, children, result),
            argType = TypeRef.Table(6),
            value = Value.Variant(
                "Ok",
                Value.Vector(
                    listOf(
                        child("/zeta.md", "zeta.md", "File"),
                        child("/Alpha", "Alpha", "Directory"),
                        child("/beta", "beta", "Folder"),
                    ),
                ),
            ),
        )
    }

    fun readNodeOk(): ByteArray =
        readNodeResult(
            Value.Some(
                Value.Record(
                    mapOf(
                        "path" to Value.Text("/docs/readme.md"),
                        "kind" to Value.Variant("File", Value.Null),
                        "content" to Value.Text("# Title"),
                        "metadata_json" to Value.Text("{\"title\":\"Readme\"}"),
                        "etag" to Value.Text("etag-1"),
                        "created_at" to Value.Int64(10L),
                        "updated_at" to Value.Int64(20L),
                    ),
                ),
            ),
        )

    fun readNodeNone(): ByteArray =
        readNodeResult(Value.None)

    fun sourceCaptureNode(request: SourceCaptureRequest): ByteArray =
        readNodeResult(
            Value.Some(
                Value.Record(
                    mapOf(
                        "path" to Value.Text(request.requestPath),
                        "kind" to Value.Variant("File", Value.Null),
                        "content" to Value.Text(request.content),
                        "metadata_json" to Value.Text(request.metadataJson),
                        "etag" to Value.Text("etag-source-capture"),
                        "created_at" to Value.Int64(10L),
                        "updated_at" to Value.Int64(20L),
                    ),
                ),
            ),
        )

    fun errText(message: String): ByteArray {
        val result = Entry.Variant(
            listOf(
                field("Ok", TypeRef.Primitive(typeNull)),
                field("Err", TypeRef.Primitive(typeText)),
            ),
        )
        return didl(
            entries = listOf(result),
            argType = TypeRef.Table(0),
            value = Value.Variant("Err", Value.Text(message)),
        )
    }

    private fun readNodeResult(value: Value): ByteArray {
        val kind = Entry.Variant(
            listOf(
                field("File", TypeRef.Primitive(typeNull)),
                field("Folder", TypeRef.Primitive(typeNull)),
                field("Source", TypeRef.Primitive(typeNull)),
            ),
        )
        val node = Entry.Record(
            listOf(
                field("path", TypeRef.Primitive(typeText)),
                field("kind", TypeRef.Table(0)),
                field("content", TypeRef.Primitive(typeText)),
                field("metadata_json", TypeRef.Primitive(typeText)),
                field("etag", TypeRef.Primitive(typeText)),
                field("created_at", TypeRef.Primitive(typeInt64)),
                field("updated_at", TypeRef.Primitive(typeInt64)),
            ),
        )
        val optionalNode = Entry.Opt(TypeRef.Table(1))
        val result = Entry.Variant(
            listOf(
                field("Ok", TypeRef.Table(2)),
                field("Err", TypeRef.Primitive(typeText)),
            ),
        )
        return didl(
            entries = listOf(kind, node, optionalNode, result),
            argType = TypeRef.Table(3),
            value = Value.Variant("Ok", value),
        )
    }

    private fun database(
        databaseId: String,
        topLevelName: String,
        role: String,
        status: String,
        metadata: Value?,
    ): Value.Record =
        Value.Record(
            mapOf(
                "database_id" to Value.Text(databaseId),
                "name" to Value.Text(topLevelName),
                "metadata" to (metadata?.let { Value.Some(it) } ?: Value.None),
                "role" to Value.Variant(role, Value.Null),
                "status" to Value.Variant(status, Value.Null),
                "logical_size_bytes" to Value.Nat64(128uL),
                "cycles_balance" to Value.None,
                "cycles_suspended_at_ms" to Value.None,
                "deleted_at_ms" to Value.None,
            ),
        )

    private fun metadataValue(name: String, description: String, summary: String): Value.Record =
        Value.Record(
            mapOf(
                "name" to Value.Text(name),
                "description" to Value.Text(description),
                "llm_summary" to Value.Some(Value.Text(summary)),
                "tags_json" to Value.Text("[\"tag\"]"),
            ),
        )

    private fun child(path: String, name: String, kind: String): Value.Record =
        Value.Record(
            mapOf(
                "path" to Value.Text(path),
                "name" to Value.Text(name),
                "kind" to Value.Variant(kind, Value.Null),
                "updated_at" to Value.Some(Value.Int64(100L)),
                "etag" to Value.Some(Value.Text("etag")),
                "size_bytes" to Value.Some(Value.Nat64(8uL)),
                "has_children" to Value.Bool(kind != "File"),
                "is_virtual" to Value.Bool(false),
            ),
        )

    private fun didl(entries: List<Entry>, argType: TypeRef, value: Value): ByteArray {
        val out = mutableListOf<Byte>()
        out += magic
        appendUnsigned(entries.size.toULong(), out)
        entries.forEach { encodeEntry(it, out) }
        appendUnsigned(1uL, out)
        encodeRef(argType, out)
        encodeValue(argType, value, entries, out)
        return out.toByteArray()
    }

    private fun encodeEntry(entry: Entry, out: MutableList<Byte>) {
        when (entry) {
            is Entry.Opt -> {
                appendSigned(typeOpt, out)
                encodeRef(entry.type, out)
            }
            is Entry.Vec -> {
                appendSigned(typeVec, out)
                encodeRef(entry.type, out)
            }
            is Entry.Record -> {
                appendSigned(typeRecord, out)
                encodeFields(entry.fields, out)
            }
            is Entry.Variant -> {
                appendSigned(typeVariant, out)
                encodeFields(entry.fields, out)
            }
        }
    }

    private fun encodeFields(fields: List<Field>, out: MutableList<Byte>) {
        val sorted = fields.sortedBy(Field::id)
        appendUnsigned(sorted.size.toULong(), out)
        sorted.forEach { field ->
            appendUnsigned(field.id.toULong(), out)
            encodeRef(field.type, out)
        }
    }

    private fun encodeValue(type: TypeRef, value: Value, entries: List<Entry>, out: MutableList<Byte>) {
        when (type) {
            is TypeRef.Primitive -> encodePrimitive(type.value, value, out)
            is TypeRef.Table -> {
                val entry = entries[type.index]
                when (entry) {
                    is Entry.Opt -> encodeOptional(entry, value, entries, out)
                    is Entry.Vec -> encodeVector(entry, value, entries, out)
                    is Entry.Record -> encodeRecord(entry, value, entries, out)
                    is Entry.Variant -> encodeVariant(entry, value, entries, out)
                }
            }
        }
    }

    private fun encodePrimitive(type: Long, value: Value, out: MutableList<Byte>) {
        when (type) {
            typeNull -> require(value == Value.Null)
            typeBool -> {
                val bool = when (value) {
                    is Value.Bool -> value.value
                    else -> error("expected bool")
                }
                out += (if (bool) 1 else 0).toByte()
            }
            typeNat64 -> {
                val nat = when (value) {
                    is Value.Nat64 -> value.value
                    else -> error("expected nat64")
                }
                appendFixedUInt64(nat, out)
            }
            typeInt64 -> {
                val int = when (value) {
                    is Value.Int64 -> value.value
                    else -> error("expected int64")
                }
                appendFixedUInt64(int.toULong(), out)
            }
            typeText -> {
                val text = when (value) {
                    is Value.Text -> value.value
                    else -> error("expected text")
                }
                appendText(text, out)
            }
            else -> error("unsupported primitive")
        }
    }

    private fun encodeOptional(entry: Entry.Opt, value: Value, entries: List<Entry>, out: MutableList<Byte>) {
        when (value) {
            Value.None -> out += 0.toByte()
            is Value.Some -> {
                out += 1.toByte()
                encodeValue(entry.type, value.value, entries, out)
            }
            else -> error("expected optional")
        }
    }

    private fun encodeVector(entry: Entry.Vec, value: Value, entries: List<Entry>, out: MutableList<Byte>) {
        val vector = when (value) {
            is Value.Vector -> value.values
            else -> error("expected vector")
        }
        appendUnsigned(vector.size.toULong(), out)
        vector.forEach { encodeValue(entry.type, it, entries, out) }
    }

    private fun encodeRecord(entry: Entry.Record, value: Value, entries: List<Entry>, out: MutableList<Byte>) {
        val record = when (value) {
            is Value.Record -> value.fields
            else -> error("expected record")
        }
        entry.fields.sortedBy(Field::id).forEach { field ->
            val child = record[field.name] ?: error("missing field")
            encodeValue(field.type, child, entries, out)
        }
    }

    private fun encodeVariant(entry: Entry.Variant, value: Value, entries: List<Entry>, out: MutableList<Byte>) {
        val variant = when (value) {
            is Value.Variant -> value
            else -> error("expected variant")
        }
        val fields = entry.fields.sortedBy(Field::id)
        val index = fields.indexOfFirst { it.name == variant.name }
        if (index < 0) error("unknown variant")
        appendUnsigned(index.toULong(), out)
        encodeValue(fields[index].type, variant.value, entries, out)
    }

    private fun encodeRef(type: TypeRef, out: MutableList<Byte>) {
        when (type) {
            is TypeRef.Primitive -> appendSigned(type.value, out)
            is TypeRef.Table -> appendSigned(type.index.toLong(), out)
        }
    }

    private fun field(name: String, type: TypeRef): Field =
        Field(id = VfsCandidLabels.id(name), name = name, type = type)

    private fun appendText(text: String, out: MutableList<Byte>) {
        val bytes = text.encodeToByteArray()
        appendUnsigned(bytes.size.toULong(), out)
        out += bytes.toList()
    }

    private fun appendFixedUInt64(value: ULong, out: MutableList<Byte>) {
        repeat(8) { index ->
            out += ((value shr (index * 8)) and 0xffu).toByte()
        }
    }

    private fun appendUnsigned(value: ULong, out: MutableList<Byte>) =
        VfsCandidLeb.appendUnsigned(value, out)

    private fun appendSigned(value: Long, out: MutableList<Byte>) =
        VfsCandidLeb.appendSigned(value, out)

    private data class Field(val id: UInt, val name: String, val type: TypeRef)

    private sealed class TypeRef {
        data class Primitive(val value: Long) : TypeRef()
        data class Table(val index: Int) : TypeRef()
    }

    private sealed class Entry {
        data class Opt(val type: TypeRef) : Entry()
        data class Vec(val type: TypeRef) : Entry()
        data class Record(val fields: List<Field>) : Entry()
        data class Variant(val fields: List<Field>) : Entry()
    }

    private sealed class Value {
        data object Null : Value()
        data object None : Value()
        data class Some(val value: Value) : Value()
        data class Bool(val value: Boolean) : Value()
        data class Text(val value: String) : Value()
        data class Nat64(val value: ULong) : Value()
        data class Int64(val value: Long) : Value()
        data class Vector(val values: List<Value>) : Value()
        data class Record(val fields: Map<String, Value>) : Value()
        data class Variant(val name: String, val value: Value) : Value()
    }
}
