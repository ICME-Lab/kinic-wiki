// Where: mobile/android/app/src/main/java/xyz/kinic/android/VfsCandidDecoder.kt
// What: Minimal Candid decoder for Android Browse VFS replies.
// Why: Android Browse needs typed database, child, and node values from raw IC query bytes.

package xyz.kinic.android

object VfsCandidDecoder {
    private val magic = byteArrayOf(0x44, 0x49, 0x44, 0x4c)
    private const val typeNull = -1L
    private const val typeBool = -2L
    private const val typeNat64 = -8L
    private const val typeInt64 = -12L
    private const val typeText = -15L
    private const val typeOpt = -18L
    private const val typeVec = -19L
    private const val typeRecord = -20L
    private const val typeVariant = -21L

    fun decodeUnitResult(data: ByteArray) {
        when (decodeResult(data)) {
            Value.Null -> Unit
            is Value.Record -> Unit
            else -> throw invalid("expected unit result")
        }
    }

    fun decodeWriteNodesResult(data: ByteArray) {
        val ok = decodeResult(data)
        val vector = ok.vectorOrNull() ?: throw invalid("expected write_nodes result")
        vector.forEach { value ->
            value.recordOrNull() ?: throw invalid("expected write_nodes item result")
        }
    }

    fun decodeDatabaseSummaries(data: ByteArray): List<DatabaseSummary> {
        val ok = decodeResult(data)
        val vector = ok.vectorOrNull() ?: throw invalid("expected database summary vector")
        return vector.map(::databaseSummary)
    }

    fun decodeChildNodesResult(data: ByteArray): List<ChildNode> {
        val ok = decodeResult(data)
        val vector = ok.vectorOrNull() ?: throw invalid("expected child node vector")
        return vector.map(::childNode)
    }

    fun decodeReadNodeResult(data: ByteArray): VfsNode? {
        val ok = decodeResult(data)
        val child = when (ok) {
            is Value.Opt -> ok.value
            else -> throw invalid("expected read_node optional result")
        } ?: return null
        val fields = child.recordOrNull() ?: throw invalid("read_node node is not a record")
        return VfsNode(
            path = text(fields, "path"),
            kind = nodeKind(variant(fields, "kind")),
            content = text(fields, "content"),
            metadataJson = text(fields, "metadata_json"),
            etag = text(fields, "etag"),
            createdAt = int64(fields, "created_at"),
            updatedAt = int64(fields, "updated_at"),
        )
    }

    private fun decodeResult(data: ByteArray): Value {
        val values = Parser(data).parse()
        if (values.size != 1) throw invalid("expected result variant")
        val variant = values.single().variantOrNull() ?: throw invalid("expected result variant")
        if (variant.label == label("Err")) {
            val message = variant.value.textOrNull() ?: throw invalid("expected Err text")
            throw VfsCandidError.CanisterRejected(message)
        }
        if (variant.label != label("Ok")) throw invalid("unknown result variant")
        return variant.value
    }

    private fun databaseSummary(value: Value): DatabaseSummary {
        val fields = value.recordOrNull() ?: throw invalid("database summary is not a record")
        val topLevelName = text(fields, "name")
        val metadataValue = fields[label("metadata")] ?: throw invalid("missing metadata field")
        val metadata = when (metadataValue) {
            is Value.Opt -> metadataValue.value?.let { child ->
                databaseMetadata(child.recordOrNull() ?: throw invalid("metadata is not a record"))
            }
            else -> throw invalid("metadata is not optional")
        }
        val title = metadata?.name ?: topLevelName
        return DatabaseSummary(
            databaseId = text(fields, "database_id"),
            title = title,
            description = metadata?.description ?: "",
            metadata = metadata,
            role = databaseRole(variant(fields, "role")),
            status = databaseStatus(variant(fields, "status")),
            logicalSizeBytes = nat64(fields, "logical_size_bytes"),
            cyclesBalance = optionalNat64(fields, "cycles_balance"),
            cyclesSuspendedAtMs = optionalInt64(fields, "cycles_suspended_at_ms"),
            deletedAtMs = optionalInt64(fields, "deleted_at_ms"),
        )
    }

    private fun databaseMetadata(fields: Map<UInt, Value>): DatabaseMetadata =
        DatabaseMetadata(
            name = text(fields, "name"),
            description = text(fields, "description"),
            llmSummary = optionalText(fields, "llm_summary"),
            tagsJson = text(fields, "tags_json"),
        )

    private fun childNode(value: Value): ChildNode {
        val fields = value.recordOrNull() ?: throw invalid("child node is not a record")
        return ChildNode(
            path = text(fields, "path"),
            name = text(fields, "name"),
            kind = nodeEntryKind(variant(fields, "kind")),
            updatedAt = optionalInt64(fields, "updated_at"),
            etag = optionalText(fields, "etag"),
            sizeBytes = optionalNat64(fields, "size_bytes"),
            hasChildren = bool(fields, "has_children"),
            isVirtual = bool(fields, "is_virtual"),
        )
    }

    private fun databaseRole(label: UInt): DatabaseRole =
        when (label) {
            label("Owner") -> DatabaseRole.OWNER
            label("Writer") -> DatabaseRole.WRITER
            label("Reader") -> DatabaseRole.READER
            else -> throw invalid("unknown database role")
        }

    private fun databaseStatus(label: UInt): DatabaseStatus =
        when (label) {
            label("Active") -> DatabaseStatus.ACTIVE
            label("Deleted") -> DatabaseStatus.DELETED
            label("Pending") -> DatabaseStatus.PENDING
            else -> throw invalid("unknown database status")
        }

    private fun nodeKind(label: UInt): VfsNodeKind =
        when (label) {
            label("File") -> VfsNodeKind.FILE
            label("Folder") -> VfsNodeKind.FOLDER
            label("Source") -> VfsNodeKind.SOURCE
            else -> throw invalid("unknown node kind")
        }

    private fun nodeEntryKind(label: UInt): VfsNodeKind =
        if (label == label("Directory")) VfsNodeKind.FOLDER else nodeKind(label)

    private fun text(fields: Map<UInt, Value>, name: String): String =
        fields[label(name)]?.textOrNull() ?: throw invalid("missing text field $name")

    private fun bool(fields: Map<UInt, Value>, name: String): Boolean =
        fields[label(name)]?.boolOrNull() ?: throw invalid("missing bool field $name")

    private fun int64(fields: Map<UInt, Value>, name: String): Long =
        fields[label(name)]?.int64OrNull() ?: throw invalid("missing int64 field $name")

    private fun nat64(fields: Map<UInt, Value>, name: String): ULong =
        fields[label(name)]?.nat64OrNull() ?: throw invalid("missing nat64 field $name")

    private fun optionalText(fields: Map<UInt, Value>, name: String): String? {
        val value = fields[label(name)] ?: throw invalid("missing optional text field $name")
        val child = when (value) {
            is Value.Opt -> value.value
            else -> throw invalid("optional field $name is not optional")
        } ?: return null
        return child.textOrNull() ?: throw invalid("optional field $name is not text")
    }

    private fun optionalInt64(fields: Map<UInt, Value>, name: String): Long? {
        val value = fields[label(name)] ?: throw invalid("missing optional int64 field $name")
        val child = when (value) {
            is Value.Opt -> value.value
            else -> throw invalid("optional field $name is not optional")
        } ?: return null
        return child.int64OrNull() ?: throw invalid("optional field $name is not int64")
    }

    private fun optionalNat64(fields: Map<UInt, Value>, name: String): ULong? {
        val value = fields[label(name)] ?: throw invalid("missing optional nat64 field $name")
        val child = when (value) {
            is Value.Opt -> value.value
            else -> throw invalid("optional field $name is not optional")
        } ?: return null
        return child.nat64OrNull() ?: throw invalid("optional field $name is not nat64")
    }

    private fun variant(fields: Map<UInt, Value>, name: String): UInt =
        fields[label(name)]?.variantOrNull()?.label ?: throw invalid("missing variant field $name")

    private fun label(name: String): UInt =
        VfsCandidLabels.id(name)

    private fun invalid(detail: String): VfsCandidError.InvalidPayload =
        VfsCandidError.InvalidPayload(detail)

    private class Parser(private val data: ByteArray) {
        private var offset = 0
        private val table = mutableListOf<TypeEntry>()

        fun parse(): List<Value> {
            if (data.size < 4 || !data.copyOfRange(0, 4).contentEquals(magic)) {
                throw invalid("missing DIDL header")
            }
            offset = 4
            val tableCount = readUnsigned()
            repeatCount(tableCount, "type table") {
                table += readTypeEntry()
            }
            val argCount = readUnsigned()
            val argTypes = mutableListOf<TypeRef>()
            repeatCount(argCount, "argument types") {
                argTypes += readTypeRef()
            }
            val values = argTypes.map(::readValue)
            if (offset != data.size) throw invalid("trailing bytes")
            return values
        }

        private fun readTypeEntry(): TypeEntry {
            return when (val code = readSigned()) {
                typeOpt -> TypeEntry.Opt(readTypeRef())
                typeVec -> TypeEntry.Vec(readTypeRef())
                typeRecord -> TypeEntry.Record(readFields())
                typeVariant -> TypeEntry.Variant(readFields())
                else -> throw invalid("unsupported type table entry $code")
            }
        }

        private fun readFields(): List<Field> {
            val fields = mutableListOf<Field>()
            repeatCount(readUnsigned(), "fields") {
                fields += Field(id = readUnsigned().toUIntChecked("field id"), type = readTypeRef())
            }
            return fields
        }

        private fun readTypeRef(): TypeRef {
            val value = readSigned()
            return if (value < 0) TypeRef.Primitive(value) else TypeRef.Table(value.toIntChecked("type reference"))
        }

        private fun readValue(type: TypeRef): Value =
            when (type) {
                is TypeRef.Primitive -> readPrimitive(type.value)
                is TypeRef.Table -> {
                    val entry = table.getOrNull(type.index) ?: throw invalid("type reference is out of bounds")
                    when (entry) {
                        is TypeEntry.Opt -> {
                            when (val tag = readByte()) {
                                0 -> Value.Opt(null)
                                1 -> Value.Opt(readValue(entry.type))
                                else -> throw invalid("invalid opt tag $tag")
                            }
                        }
                        is TypeEntry.Vec -> {
                            val values = mutableListOf<Value>()
                            repeatCount(readUnsigned(), "vector") {
                                values += readValue(entry.type)
                            }
                            Value.Vector(values)
                        }
                        is TypeEntry.Record -> {
                            val values = mutableMapOf<UInt, Value>()
                            entry.fields.forEach { field ->
                                values[field.id] = readValue(field.type)
                            }
                            Value.Record(values)
                        }
                        is TypeEntry.Variant -> {
                            val index = readUnsigned().toIntChecked("variant index")
                            val field = entry.fields.getOrNull(index) ?: throw invalid("variant index is out of bounds")
                            Value.Variant(field.id, readValue(field.type))
                        }
                    }
                }
            }

        private fun readPrimitive(code: Long): Value =
            when (code) {
                typeNull -> Value.Null
                typeBool -> when (val byte = readByte()) {
                    0 -> Value.Bool(false)
                    1 -> Value.Bool(true)
                    else -> throw invalid("invalid bool $byte")
                }
                typeNat64 -> Value.Nat64(readFixedUInt64())
                typeInt64 -> Value.Int64(readFixedUInt64().toLong())
                typeText -> {
                    val count = readUnsigned().toIntChecked("text length")
                    if (offset + count > data.size) throw invalid("text exceeds payload")
                    val bytes = data.copyOfRange(offset, offset + count)
                    offset += count
                    Value.Text(bytes.toString(Charsets.UTF_8))
                }
                else -> throw invalid("unsupported primitive $code")
            }

        private fun readFixedUInt64(): ULong {
            if (offset + 8 > data.size) throw invalid("nat64 exceeds payload")
            var result = 0uL
            repeat(8) { index ->
                result = result or (data[offset + index].toUByte().toULong() shl (index * 8))
            }
            offset += 8
            return result
        }

        private fun readByte(): Int {
            if (offset >= data.size) throw invalid("unexpected end of payload")
            val byte = data[offset].toInt() and 0xff
            offset += 1
            return byte
        }

        private fun readUnsigned(): ULong {
            var shift = 0
            var result = 0uL
            while (true) {
                val byte = readByte()
                result = result or ((byte and 0x7f).toULong() shl shift)
                if (byte and 0x80 == 0) return result
                shift += 7
                if (shift > 63) throw invalid("unsigned LEB128 is too large")
            }
        }

        private fun readSigned(): Long {
            var shift = 0
            var result = 0L
            var byte: Int
            do {
                byte = readByte()
                result = result or ((byte and 0x7f).toLong() shl shift)
                shift += 7
                if (shift > 70) throw invalid("signed LEB128 is too large")
            } while (byte and 0x80 != 0)
            if (shift < 64 && byte and 0x40 != 0) {
                result = result or (-1L shl shift)
            }
            return result
        }

        private fun repeatCount(count: ULong, label: String, block: () -> Unit) {
            repeat(count.toIntChecked("$label count")) { block() }
        }
    }

    private data class Field(val id: UInt, val type: TypeRef)

    private sealed class TypeRef {
        data class Primitive(val value: Long) : TypeRef()
        data class Table(val index: Int) : TypeRef()
    }

    private sealed class TypeEntry {
        data class Opt(val type: TypeRef) : TypeEntry()
        data class Vec(val type: TypeRef) : TypeEntry()
        data class Record(val fields: List<Field>) : TypeEntry()
        data class Variant(val fields: List<Field>) : TypeEntry()
    }

    private sealed class Value {
        data object Null : Value()
        data class Bool(val value: Boolean) : Value()
        data class Text(val value: String) : Value()
        data class Nat64(val value: ULong) : Value()
        data class Int64(val value: Long) : Value()
        data class Opt(val value: Value?) : Value()
        data class Vector(val values: List<Value>) : Value()
        data class Record(val fields: Map<UInt, Value>) : Value()
        data class Variant(val label: UInt, val value: Value) : Value()

        fun boolOrNull(): Boolean? = if (this is Bool) value else null
        fun textOrNull(): String? = if (this is Text) value else null
        fun nat64OrNull(): ULong? = if (this is Nat64) value else null
        fun int64OrNull(): Long? = if (this is Int64) value else null
        fun vectorOrNull(): List<Value>? = if (this is Vector) values else null
        fun recordOrNull(): Map<UInt, Value>? = if (this is Record) fields else null
        fun variantOrNull(): Variant? = if (this is Variant) this else null
    }
}

private fun ULong.toIntChecked(label: String): Int {
    if (this > Int.MAX_VALUE.toULong()) throw VfsCandidError.InvalidPayload("$label is too large")
    return toInt()
}

private fun Long.toIntChecked(label: String): Int {
    if (this !in 0..Int.MAX_VALUE.toLong()) throw VfsCandidError.InvalidPayload("$label is out of range")
    return toInt()
}

private fun ULong.toUIntChecked(label: String): UInt {
    if (this > UInt.MAX_VALUE.toULong()) throw VfsCandidError.InvalidPayload("$label is too large")
    return toUInt()
}
