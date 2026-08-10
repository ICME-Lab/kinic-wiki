package xyz.kinic.android

import xyz.kinic.android.ic.IcAuthSession
import xyz.kinic.android.ic.IcDelegationChain

internal const val EXTRA_UI_REFERENCE_MODE = "xyz.kinic.android.UI_REFERENCE_MODE"

internal data class KinicUiReferenceFixture(
    val destination: KinicTopLevelDestination,
    val appState: KinicAppUiState,
    val askState: AskAiUiState = AskAiUiState(isLoadingHistory = false),
)

internal fun kinicUiReferenceFixture(mode: String?): KinicUiReferenceFixture? {
    val database = referenceDatabase()
    val session = referenceSession()
    val entry = BrowseDatabaseEntry(database, setOf(BrowseDatabaseOrigin.MEMBER))
    val common = KinicAppUiState(
        session = session,
        browseDatabases = listOf(entry),
        memberDatabases = listOf(database),
        selectedCaptureDatabaseId = database.databaseId,
        selectedBrowseDatabaseId = database.databaseId,
        browseChildren = referenceChildren(),
        manage = ManageUiState(
            selectedDatabaseId = database.databaseId,
            members = listOf(DatabaseMember(session.principal, DatabaseRole.OWNER, 0)),
        ),
        darkMode = DarkMode.LIGHT,
    )
    return when (mode?.lowercase()) {
        "home" -> KinicUiReferenceFixture(
            destination = KinicTopLevelDestination.HOME,
            appState = KinicAppUiState(darkMode = DarkMode.LIGHT, message = "Sign in before submitting."),
        )
        "browse" -> KinicUiReferenceFixture(
            KinicTopLevelDestination.BROWSE,
            common.copy(selectedBrowseDatabaseId = ""),
        )
        "ask-ai" -> KinicUiReferenceFixture(
            destination = KinicTopLevelDestination.ASK_AI,
            appState = common,
            askState = referenceAskAiState(database),
        )
        "manage" -> KinicUiReferenceFixture(KinicTopLevelDestination.MANAGE, common)
        else -> null
    }
}

private fun referenceDatabase() = DatabaseSummary(
    databaseId = "personal-memory",
    title = "Personal Memory",
    description = "Grounded notes for agent memory research.",
    metadata = DatabaseMetadata(
        name = "Personal Memory",
        description = "Grounded notes for agent memory research.",
        llmSummary = "Source-backed notes about reliable agent memory.",
        tagsJson = "[\"memory\",\"research\"]",
    ),
    role = DatabaseRole.OWNER,
    status = DatabaseStatus.ACTIVE,
    logicalSizeBytes = 24576u,
    cyclesBalance = 1_250_000_000u,
    cyclesSuspendedAtMs = null,
    deletedAtMs = null,
)

private fun referenceChildren() = listOf(
    ChildNode(
        path = "/Knowledge",
        name = "Knowledge",
        kind = VfsNodeKind.FOLDER,
        updatedAt = 1_786_000_000,
        etag = "knowledge",
        sizeBytes = null,
        hasChildren = true,
        isVirtual = false,
    ),
    ChildNode(
        path = "/Agent Memory.md",
        name = "Agent Memory.md",
        kind = VfsNodeKind.FILE,
        updatedAt = 1_786_000_100,
        etag = "agent-memory",
        sizeBytes = 2048u,
        hasChildren = false,
        isVirtual = false,
    ),
)

private fun referenceAskAiState(database: DatabaseSummary): AskAiUiState {
    val messages = listOf(
        AskAiMessage(role = AskAiMessageRole.USER, text = "What makes agent memory reliable?"),
        AskAiMessage(
            role = AskAiMessageRole.ASSISTANT,
            text = "Reliable agent memory stays **grounded in source notes**, keeps retrieval scoped to one database, and shows the evidence behind each answer.",
            sources = listOf(
                AskAiSource(
                    id = "S1",
                    path = "/Knowledge/AI Research Notes.md",
                    excerpt = "Reliable memory keeps source context, retrieval boundaries, and evidence visible.",
                    score = 0.96f,
                    matchReasons = listOf("title", "content"),
                ),
            ),
            trace = listOf(
                AskAiTraceEvent(stage = AskAiTraceStage.SEARCHING, title = "Searched with 3 queries"),
                AskAiTraceEvent(stage = AskAiTraceStage.FOUND, title = "Found 4 candidate notes"),
                AskAiTraceEvent(stage = AskAiTraceStage.VERIFYING, title = "Verified 2 matching notes"),
            ),
        ),
    )
    val conversation = AskAiConversation(
        databaseId = database.databaseId,
        databaseTitle = database.displayTitle,
        title = "Reliable agent memory",
        messages = messages,
    )
    return AskAiUiState(
        conversations = listOf(conversation),
        currentConversation = conversation,
        isLoadingHistory = false,
    )
}

private fun referenceSession() = IcAuthSession(
    principal = "aaaaa-aa",
    canisterId = "reference",
    identityProvider = "reference",
    derivationOrigin = "reference",
    sessionPublicKey = ByteArray(32),
    sessionPrivateKey = ByteArray(32),
    delegation = IcDelegationChain(publicKey = ByteArray(32), delegations = emptyList()),
)
