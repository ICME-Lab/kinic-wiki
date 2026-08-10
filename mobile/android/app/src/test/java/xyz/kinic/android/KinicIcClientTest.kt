// Where: mobile/android/app/src/test/java/xyz/kinic/android/KinicIcClientTest.kt
// What: JVM tests for source-capture IC result handling.
// Why: Canister Err replies must stop the Android capture workflow before later side effects.

package xyz.kinic.android

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.assertThrows
import org.junit.Test
import xyz.kinic.android.ic.IcAuthSession
import xyz.kinic.android.ic.IcCbor
import xyz.kinic.android.ic.IcHttpResponse
import xyz.kinic.android.ic.IcHttpTransport
import xyz.kinic.android.ic.IcIdentitySession
import xyz.kinic.android.ic.identityDelegation
import java.net.URI

class KinicIcClientTest {
    @Test
    fun writeNodesErrStopsBeforeAuthorizeAndTrigger() {
        val transport = RecordingIcTransport(
            mutableListOf(
                cborReply(CandidFixture.readNodeNone()),
                cborReply(CaptureResultFixture.err("write denied")),
            ),
        )
        val worker = RecordingWorkerTrigger()
        val client = KinicIcClient(
            configuration = testAppConfiguration(),
            client = xyz.kinic.android.ic.IcClient(testAppConfiguration().icClientConfiguration(), transport),
            workerTrigger = worker,
        )

        val error = assertThrows(VfsCandidError.CanisterRejected::class.java) {
            runBlocking { client.saveSourceCaptureRequest(testRequest(), testSession()) }
        }

        assertEquals("write denied", error.detail)
        assertEquals(listOf("query read_node", "update write_nodes"), transport.operations)
        assertFalse(worker.called)
    }

    @Test
    fun authorizeErrStopsBeforeTrigger() {
        val transport = RecordingIcTransport(
            mutableListOf(
                cborReply(CandidFixture.readNodeNone()),
                cborReply(CaptureResultFixture.writeNodesOk()),
                cborReply(CaptureResultFixture.err("authorize denied")),
            ),
        )
        val worker = RecordingWorkerTrigger()
        val client = KinicIcClient(
            configuration = testAppConfiguration(),
            client = xyz.kinic.android.ic.IcClient(testAppConfiguration().icClientConfiguration(), transport),
            workerTrigger = worker,
        )

        val error = assertThrows(VfsCandidError.CanisterRejected::class.java) {
            runBlocking { client.saveSourceCaptureRequest(testRequest(), testSession()) }
        }

        assertEquals("authorize denied", error.detail)
        assertEquals(
            listOf("query read_node", "update write_nodes", "update authorize_source_capture_trigger_session"),
            transport.operations,
        )
        assertFalse(worker.called)
    }

    @Test
    fun successfulWriteAndAuthorizeReturnSubmission() = runBlocking {
        val transport = RecordingIcTransport(
            mutableListOf(
                cborReply(CandidFixture.readNodeNone()),
                cborReply(CaptureResultFixture.writeNodesOk()),
                cborReply(CaptureResultFixture.unitOk()),
            ),
        )
        val worker = RecordingWorkerTrigger()
        val client = KinicIcClient(
            configuration = testAppConfiguration(),
            client = xyz.kinic.android.ic.IcClient(testAppConfiguration().icClientConfiguration(), transport),
            workerTrigger = worker,
        )

        val submission = client.saveSourceCaptureRequest(testRequest(), testSession())

        assertEquals("db_demo", submission.databaseId)
        assertEquals("/Sources/source-capture-requests/request-1.md", submission.requestPath)
        assertEquals(
            listOf("query read_node", "update write_nodes", "update authorize_source_capture_trigger_session"),
            transport.operations,
        )
        assertFalse(worker.called)
    }

    @Test
    fun identicalExistingRequestSkipsWriteAndAuthorizesAgain() = runBlocking {
        val request = testRequest()
        val transport = RecordingIcTransport(
            mutableListOf(
                cborReply(CandidFixture.sourceCaptureNode(request)),
                cborReply(CaptureResultFixture.unitOk()),
            ),
        )
        val client = KinicIcClient(
            configuration = testAppConfiguration(),
            client = xyz.kinic.android.ic.IcClient(testAppConfiguration().icClientConfiguration(), transport),
            workerTrigger = RecordingWorkerTrigger(),
        )

        val submission = client.saveSourceCaptureRequest(request, testSession())

        assertEquals(request.requestPath, submission.requestPath)
        assertEquals(
            listOf("query read_node", "update authorize_source_capture_trigger_session"),
            transport.operations,
        )
    }

    @Test
    fun conflictingExistingRequestStopsBeforeWriteAndAuthorize() {
        val transport = RecordingIcTransport(
            mutableListOf(cborReply(CandidFixture.readNodeOk())),
        )
        val client = KinicIcClient(
            configuration = testAppConfiguration(),
            client = xyz.kinic.android.ic.IcClient(testAppConfiguration().icClientConfiguration(), transport),
            workerTrigger = RecordingWorkerTrigger(),
        )

        val error = assertThrows(SourceCaptureSubmissionError.ConflictingRequest::class.java) {
            runBlocking { client.saveSourceCaptureRequest(testRequest(), testSession()) }
        }

        assertEquals(testRequest().requestPath, error.path)
        assertEquals(listOf("query read_node"), transport.operations)
    }
}

private class RecordingIcTransport(
    private val responses: MutableList<IcHttpResponse>,
) : IcHttpTransport {
    val operations = mutableListOf<String>()

    override suspend fun postCbor(url: URI, body: ByteArray, operation: String): IcHttpResponse {
        operations += operation
        return responses.removeAt(0)
    }
}

private class RecordingWorkerTrigger : SourceCaptureWorkerTrigger {
    var called = false

    override suspend fun trigger(request: TriggerSourceCaptureRequest): TriggerSourceCaptureResult {
        called = true
        return TriggerSourceCaptureResult(accepted = true, error = null)
    }
}

private object CaptureResultFixture {
    private val magic = listOf(0x44, 0x49, 0x44, 0x4c).map(Int::toByte)
    private const val typeNull = -1L
    private const val typeText = -15L
    private const val typeVec = -19L
    private const val typeRecord = -20L
    private const val typeVariant = -21L

    fun unitOk(): ByteArray =
        didl(
            entries = listOf(Entry.Variant(listOf(field("Ok", TypeRef.Primitive(typeNull)), field("Err", TypeRef.Primitive(typeText))))),
            argType = TypeRef.Table(0),
            value = Value.Variant("Ok", Value.Null),
        )

    fun writeNodesOk(): ByteArray =
        didl(
            entries = listOf(
                Entry.Record(emptyList()),
                Entry.Vec(TypeRef.Table(0)),
                Entry.Variant(listOf(field("Ok", TypeRef.Table(1)), field("Err", TypeRef.Primitive(typeText)))),
            ),
            argType = TypeRef.Table(2),
            value = Value.Variant("Ok", Value.Vector(listOf(Value.Record(emptyMap())))),
        )

    fun err(message: String): ByteArray =
        didl(
            entries = listOf(Entry.Variant(listOf(field("Ok", TypeRef.Primitive(typeNull)), field("Err", TypeRef.Primitive(typeText))))),
            argType = TypeRef.Table(0),
            value = Value.Variant("Err", Value.Text(message)),
        )

    private fun didl(entries: List<Entry>, argType: TypeRef, value: Value): ByteArray {
        val out = mutableListOf<Byte>()
        out += magic
        VfsCandidLeb.appendUnsigned(entries.size.toULong(), out)
        entries.forEach { encodeEntry(it, out) }
        VfsCandidLeb.appendUnsigned(1uL, out)
        encodeRef(argType, out)
        encodeValue(argType, value, entries, out)
        return out.toByteArray()
    }

    private fun encodeEntry(entry: Entry, out: MutableList<Byte>) {
        when (entry) {
            is Entry.Record -> {
                VfsCandidLeb.appendSigned(typeRecord, out)
                encodeFields(entry.fields, out)
            }
            is Entry.Vec -> {
                VfsCandidLeb.appendSigned(typeVec, out)
                encodeRef(entry.type, out)
            }
            is Entry.Variant -> {
                VfsCandidLeb.appendSigned(typeVariant, out)
                encodeFields(entry.fields, out)
            }
        }
    }

    private fun encodeFields(fields: List<Field>, out: MutableList<Byte>) {
        val sorted = fields.sortedBy(Field::id)
        VfsCandidLeb.appendUnsigned(sorted.size.toULong(), out)
        sorted.forEach { field ->
            VfsCandidLeb.appendUnsigned(field.id.toULong(), out)
            encodeRef(field.type, out)
        }
    }

    private fun encodeValue(type: TypeRef, value: Value, entries: List<Entry>, out: MutableList<Byte>) {
        when (type) {
            is TypeRef.Primitive -> encodePrimitive(type.value, value, out)
            is TypeRef.Table -> {
                when (val entry = entries[type.index]) {
                    is Entry.Record -> encodeRecord(entry, value, out)
                    is Entry.Vec -> encodeVector(entry, value, entries, out)
                    is Entry.Variant -> encodeVariant(entry, value, entries, out)
                }
            }
        }
    }

    private fun encodePrimitive(type: Long, value: Value, out: MutableList<Byte>) {
        when (type) {
            typeNull -> require(value == Value.Null)
            typeText -> {
                val text = when (value) {
                    is Value.Text -> value.value
                    else -> error("expected text")
                }
                val bytes = text.encodeToByteArray()
                VfsCandidLeb.appendUnsigned(bytes.size.toULong(), out)
                out += bytes.toList()
            }
            else -> error("unsupported primitive")
        }
    }

    private fun encodeRecord(entry: Entry.Record, value: Value, out: MutableList<Byte>) {
        val record = when (value) {
            is Value.Record -> value.fields
            else -> error("expected record")
        }
        entry.fields.sortedBy(Field::id).forEach { field ->
            encodePrimitive(field.type.primitiveValue(), record[field.name] ?: error("missing field"), out)
        }
    }

    private fun encodeVector(entry: Entry.Vec, value: Value, entries: List<Entry>, out: MutableList<Byte>) {
        val values = when (value) {
            is Value.Vector -> value.values
            else -> error("expected vector")
        }
        VfsCandidLeb.appendUnsigned(values.size.toULong(), out)
        values.forEach { encodeValue(entry.type, it, entries, out) }
    }

    private fun encodeVariant(entry: Entry.Variant, value: Value, entries: List<Entry>, out: MutableList<Byte>) {
        val variant = when (value) {
            is Value.Variant -> value
            else -> error("expected variant")
        }
        val fields = entry.fields.sortedBy(Field::id)
        val index = fields.indexOfFirst { it.name == variant.name }
        if (index < 0) error("unknown variant")
        VfsCandidLeb.appendUnsigned(index.toULong(), out)
        encodeValue(fields[index].type, variant.value, entries, out)
    }

    private fun encodeRef(type: TypeRef, out: MutableList<Byte>) {
        when (type) {
            is TypeRef.Primitive -> VfsCandidLeb.appendSigned(type.value, out)
            is TypeRef.Table -> VfsCandidLeb.appendSigned(type.index.toLong(), out)
        }
    }

    private fun field(name: String, type: TypeRef): Field =
        Field(id = VfsCandidLabels.id(name), name = name, type = type)

    private fun TypeRef.primitiveValue(): Long =
        when (this) {
            is TypeRef.Primitive -> value
            is TypeRef.Table -> error("expected primitive")
        }

    private data class Field(val id: UInt, val name: String, val type: TypeRef)

    private sealed class TypeRef {
        data class Primitive(val value: Long) : TypeRef()
        data class Table(val index: Int) : TypeRef()
    }

    private sealed class Entry {
        data class Record(val fields: List<Field>) : Entry()
        data class Vec(val type: TypeRef) : Entry()
        data class Variant(val fields: List<Field>) : Entry()
    }

    private sealed class Value {
        data object Null : Value()
        data class Text(val value: String) : Value()
        data class Vector(val values: List<Value>) : Value()
        data class Record(val fields: Map<String, Value>) : Value()
        data class Variant(val name: String, val value: Value) : Value()
    }
}

private fun cborReply(arg: ByteArray): IcHttpResponse =
    IcHttpResponse(
        statusCode = 200,
        body = IcCbor.encode(
            IcCbor.Value.MapValue(
                listOf(
                    IcCbor.Value.Text("status") to IcCbor.Value.Text("replied"),
                    IcCbor.Value.Text("reply") to IcCbor.Value.MapValue(
                        listOf(IcCbor.Value.Text("arg") to IcCbor.Value.Bytes(arg)),
                    ),
                ),
            ),
        ),
    )

private fun testRequest(): SourceCaptureRequest =
    SourceCaptureRequest(
        databaseId = "db_demo",
        requestId = "request-1",
        requestPath = "/Sources/source-capture-requests/request-1.md",
        content = "content",
        metadataJson = "{}",
        normalizedUrl = URI("https://example.com/page"),
    )

private fun testSession(): IcAuthSession {
    val configuration = testAppConfiguration().icClientConfiguration()
    val privateKey = IcIdentitySession.generateSessionPrivateKey()
    return IcIdentitySession.makeSession(identityDelegation(privateKey, configuration.canisterId), privateKey, configuration)
}
