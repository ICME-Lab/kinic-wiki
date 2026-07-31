package xyz.kinic.android

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import xyz.kinic.android.ic.IcAuthSession
import java.net.URI

enum class KinicTopLevelDestination(val route: String, val label: String) {
    HOME("home", "Home"),
    BROWSE("browse", "Browse"),
    ASK_AI("ask-ai", "Ask AI"),
    MANAGE("manage", "Manage"),
}

enum class BrowseDatabaseOrigin {
    MEMBER,
    PUBLIC,
    PURCHASED,
    DIRECT,
}

enum class BrowseSort {
    NAME,
    MODIFIED,
}

data class BrowseDatabaseEntry(
    val summary: DatabaseSummary,
    val origins: Set<BrowseDatabaseOrigin>,
)

data class ManageUiState(
    val selectedDatabaseId: String = "",
    val members: List<DatabaseMember> = emptyList(),
    val cycleEntries: List<DatabaseCycleEntry> = emptyList(),
    val pendingPurchases: List<DatabaseCyclesPendingPurchase> = emptyList(),
    val billingConfig: CyclesBillingConfig? = null,
    val nextCursor: ULong? = null,
    val previousCursors: List<ULong?> = emptyList(),
    val currentCursor: ULong? = null,
    val pendingFundingDatabaseId: String? = null,
    val isLoading: Boolean = false,
    val busyAction: String? = null,
)

data class KinicAppUiState(
    val session: IcAuthSession? = null,
    val pendingUrls: List<PendingSharedUrl> = emptyList(),
    val message: String = "",
    val isLoadingDatabases: Boolean = false,
    val browseDatabases: List<BrowseDatabaseEntry> = emptyList(),
    val memberDatabases: List<DatabaseSummary> = emptyList(),
    val directDatabaseIds: Set<String> = emptySet(),
    val selectedCaptureDatabaseId: String = "",
    val selectedBrowseDatabaseId: String = "",
    val browsePath: String = "/",
    val browseChildren: List<ChildNode> = emptyList(),
    val browseDocument: VfsNode? = null,
    val browseSearchQuery: String = "",
    val browseSearchResults: List<SearchNodeHit> = emptyList(),
    val browseSort: BrowseSort = BrowseSort.NAME,
    val showRawDocument: Boolean = false,
    val showPublicDatabases: Boolean = true,
    val showPurchasedDatabases: Boolean = false,
    val darkMode: DarkMode = DarkMode.SYSTEM,
    val generationLanguage: WikiOutputLanguage = WikiOutputLanguage.ENGLISH,
    val sourceCaptureHistory: List<SourceCaptureHistoryRecord> = emptyList(),
    val isLoadingSourceCaptureHistory: Boolean = false,
    val sourceCaptureRetryPaths: Set<String> = emptySet(),
    val manage: ManageUiState = ManageUiState(),
    val requestedDestination: KinicTopLevelDestination = KinicTopLevelDestination.HOME,
    val navigationRequestId: Long = 0,
)

sealed interface KinicAppEvent {
    data class OpenUri(val uri: URI) : KinicAppEvent
    data class CopyText(val label: String, val value: String) : KinicAppEvent
}

class KinicAppViewModel(
    private val configuration: AppConfiguration,
    private val authService: KinicAuthService,
    private val settingsStore: KinicSettingsStore,
    private val inbox: ShareInbox,
    private val submitter: SourceCaptureSubmitter,
    private val vfsClient: KinicVfsClient,
    private val historyStore: SourceCaptureHistoryStore,
    private val icClient: KinicIcClient,
) : ViewModel(), AskAiKnowledgeProvider {
    private val _uiState = MutableStateFlow(
        KinicAppUiState(
            session = authService.restore(),
            pendingUrls = inbox.loadPendingUrls(),
            selectedCaptureDatabaseId = settingsStore.selectedDatabaseId,
            selectedBrowseDatabaseId = settingsStore.selectedBrowseDatabaseId,
            showPublicDatabases = settingsStore.showPublicDatabases,
            showPurchasedDatabases = settingsStore.showPurchasedDatabases,
            darkMode = settingsStore.darkMode,
            generationLanguage = settingsStore.generationLanguage,
        ),
    )
    val uiState: StateFlow<KinicAppUiState> = _uiState.asStateFlow()
    override val appState: StateFlow<KinicAppUiState> = uiState

    private val _events = MutableSharedFlow<KinicAppEvent>(extraBufferCapacity = 4)
    val events: SharedFlow<KinicAppEvent> = _events.asSharedFlow()

    init {
        refreshDatabases()
    }

    fun startSignIn() {
        runCatching(authService::startSignIn)
            .onSuccess { uri ->
                _uiState.update { it.copy(message = "Opening Internet Identity...") }
                _events.tryEmit(KinicAppEvent.OpenUri(uri))
            }
            .onFailure(::showError)
    }

    fun completeSignIn(callbackUri: URI) {
        runCatching { authService.completeSignIn(callbackUri) }
            .onSuccess { session ->
                _uiState.update { it.copy(session = session, message = "Signed in.") }
                refreshDatabases()
            }
            .onFailure(::showError)
    }

    fun signOut() {
        authService.signOut()
        _uiState.update {
            it.copy(
                session = null,
                memberDatabases = emptyList(),
                message = "Signed out.",
                manage = ManageUiState(),
            )
        }
        refreshDatabases()
    }

    fun copyPrincipal() {
        val principal = _uiState.value.session?.principal ?: return
        _events.tryEmit(KinicAppEvent.CopyText("Principal", principal))
    }

    fun openPrivacyPolicy() {
        _events.tryEmit(KinicAppEvent.OpenUri(configuration.authOrigin.resolve("/privacy")))
    }

    fun openExternalUrl(value: String) {
        val uri = runCatching { URI(value) }.getOrNull()
        if (uri?.scheme !in setOf("http", "https")) {
            _uiState.update { it.copy(message = "Only HTTP and HTTPS links can be opened.") }
            return
        }
        _events.tryEmit(KinicAppEvent.OpenUri(requireNotNull(uri)))
    }

    fun handleDestination(destination: KinicDestination) {
        when (destination) {
            is KinicDestination.AuthCallback -> completeSignIn(destination.uri)
            is KinicDestination.Database -> {
                addDirectDatabase(destination.databaseId)
                if (destination.nodePath != "/") openBrowseNode(destination.nodePath)
                requestNavigation(KinicTopLevelDestination.BROWSE)
            }
            KinicDestination.Dashboard,
            is KinicDestination.Cycles,
            -> {
                if (destination is KinicDestination.Cycles && !destination.databaseId.isNullOrBlank()) {
                    selectManageDatabase(destination.databaseId)
                }
                requestNavigation(KinicTopLevelDestination.MANAGE)
            }
            KinicDestination.Profile,
            KinicDestination.Root,
            -> requestNavigation(KinicTopLevelDestination.HOME)
        }
    }

    fun refreshDatabases() {
        viewModelScope.launch {
            _uiState.update { it.copy(isLoadingDatabases = true) }
            val state = _uiState.value
            val session = state.session
            val memberResult = if (session == null) {
                Result.success(emptyList())
            } else {
                runCatching { vfsClient.listReadableDatabases(session) }
            }
            val publicResult = if (state.showPublicDatabases) {
                runCatching { vfsClient.listPublicDatabases() }
            } else {
                Result.success(emptyList())
            }
            val purchasedResult = if (session == null) {
                Result.success(emptySet())
            } else {
                runCatching { loadPurchasedDatabaseIds(session) }
            }
            val members = memberResult.getOrElse {
                showError(it)
                emptyList()
            }
            val publicDatabases = publicResult.getOrElse {
                _uiState.update { current ->
                    current.copy(message = "Public database list unavailable: ${errorMessage(it)}")
                }
                emptyList()
            }
            val purchasedIds = purchasedResult.getOrElse {
                _uiState.update { current ->
                    current.copy(message = "Purchased database list unavailable: ${errorMessage(it)}")
                }
                emptySet()
            }
            val merged = mergeBrowseDatabases(
                memberDatabases = members,
                publicDatabases = publicDatabases,
                purchasedDatabaseIds = purchasedIds,
                purchasedLookupSucceeded = purchasedResult.isSuccess,
                showPublic = state.showPublicDatabases,
                showPurchased = state.showPurchasedDatabases,
                directDatabaseIds = state.directDatabaseIds,
            )
            val writable = members.filter { it.canWrite || (it.status == DatabaseStatus.PENDING && it.role.canWrite) }
            val captureId = state.selectedCaptureDatabaseId
                .takeIf { id -> writable.any { it.databaseId == id } }
                ?: writable.firstOrNull()?.databaseId.orEmpty()
            val browseId = state.selectedBrowseDatabaseId
                .takeIf { id -> merged.any { it.summary.databaseId == id } }
                ?: merged.firstOrNull()?.summary?.databaseId.orEmpty()
            settingsStore.selectedDatabaseId = captureId
            settingsStore.selectedBrowseDatabaseId = browseId
            _uiState.update {
                it.copy(
                    isLoadingDatabases = false,
                    browseDatabases = merged,
                    memberDatabases = members,
                    selectedCaptureDatabaseId = captureId,
                    selectedBrowseDatabaseId = browseId,
                )
            }
            if (browseId.isNotBlank()) {
                loadBrowsePath("/")
            }
            refreshSourceCaptureHistory()
        }
    }

    fun setShowPublicDatabases(enabled: Boolean) {
        settingsStore.showPublicDatabases = enabled
        _uiState.update { it.copy(showPublicDatabases = enabled) }
        refreshDatabases()
    }

    fun setShowPurchasedDatabases(enabled: Boolean) {
        settingsStore.showPurchasedDatabases = enabled
        _uiState.update { it.copy(showPurchasedDatabases = enabled) }
        refreshDatabases()
    }

    fun setDarkMode(mode: DarkMode) {
        settingsStore.darkMode = mode
        _uiState.update { it.copy(darkMode = mode) }
    }

    fun setGenerationLanguage(language: WikiOutputLanguage) {
        settingsStore.generationLanguage = language
        _uiState.update { it.copy(generationLanguage = language) }
    }

    fun selectCaptureDatabase(databaseId: String) {
        settingsStore.selectedDatabaseId = databaseId
        _uiState.update { it.copy(selectedCaptureDatabaseId = databaseId) }
        refreshSourceCaptureHistory()
    }

    fun selectBrowseDatabase(databaseId: String) {
        settingsStore.selectedBrowseDatabaseId = databaseId
        _uiState.update {
            it.copy(
                selectedBrowseDatabaseId = databaseId,
                browsePath = "/",
                browseDocument = null,
                browseSearchResults = emptyList(),
            )
        }
        loadBrowsePath("/")
    }

    fun addDirectDatabase(databaseId: String) {
        val trimmed = databaseId.trim()
        if (trimmed.isBlank()) {
            _uiState.update { it.copy(message = "Database ID is required.") }
            return
        }
        _uiState.update { it.copy(directDatabaseIds = it.directDatabaseIds + trimmed) }
        val merged = mergeBrowseDatabases(
            memberDatabases = _uiState.value.memberDatabases,
            publicDatabases = _uiState.value.browseDatabases
                .filter { BrowseDatabaseOrigin.PUBLIC in it.origins }
                .map(BrowseDatabaseEntry::summary),
            purchasedDatabaseIds = _uiState.value.browseDatabases
                .filter { BrowseDatabaseOrigin.PURCHASED in it.origins }
                .mapTo(mutableSetOf()) { it.summary.databaseId },
            purchasedLookupSucceeded = true,
            showPublic = _uiState.value.showPublicDatabases,
            showPurchased = _uiState.value.showPurchasedDatabases,
            directDatabaseIds = _uiState.value.directDatabaseIds,
        )
        _uiState.update { it.copy(browseDatabases = merged) }
        selectBrowseDatabase(trimmed)
    }

    fun loadBrowsePath(path: String) {
        val database = selectedBrowseEntry() ?: return
        viewModelScope.launch {
            runCatching {
                vfsClient.listBrowseChildren(
                    databaseId = database.summary.databaseId,
                    path = normalizedPath(path),
                    session = browseSession(database),
                )
            }.onSuccess { children ->
                _uiState.update {
                    it.copy(
                        browsePath = normalizedPath(path),
                        browseChildren = sortChildren(children, it.browseSort),
                        browseDocument = null,
                        message = "",
                    )
                }
            }.onFailure(::showError)
        }
    }

    fun openBrowseNode(path: String) {
        val database = selectedBrowseEntry() ?: return
        viewModelScope.launch {
            runCatching {
                vfsClient.readBrowseNode(database.summary.databaseId, normalizedPath(path), browseSession(database))
            }.onSuccess { node ->
                if (node == null) {
                    _uiState.update { it.copy(message = "Document not found. Opened its parent folder.") }
                    loadBrowsePath(parentPath(path))
                } else if (node.kind == VfsNodeKind.FOLDER) {
                    loadBrowsePath(node.path)
                } else {
                    _uiState.update { it.copy(browseDocument = node, browsePath = parentPath(node.path), message = "") }
                }
            }.onFailure(::showError)
        }
    }

    fun navigateBrowseBack() {
        val document = _uiState.value.browseDocument
        if (document != null) {
            _uiState.update { it.copy(browseDocument = null) }
        } else {
            loadBrowsePath(parentPath(_uiState.value.browsePath))
        }
    }

    fun setBrowseSort(sort: BrowseSort) {
        _uiState.update {
            it.copy(
                browseSort = sort,
                browseChildren = sortChildren(it.browseChildren, sort),
            )
        }
    }

    fun setRawDocument(enabled: Boolean) {
        _uiState.update { it.copy(showRawDocument = enabled) }
    }

    fun setBrowseSearchQuery(query: String) {
        _uiState.update { it.copy(browseSearchQuery = query) }
    }

    fun searchBrowse() {
        val state = _uiState.value
        val database = selectedBrowseEntry() ?: return
        val query = state.browseSearchQuery.trim()
        if (query.isBlank()) {
            _uiState.update { it.copy(browseSearchResults = emptyList()) }
            return
        }
        viewModelScope.launch {
            runCatching {
                vfsClient.searchBrowseNodes(
                    databaseId = database.summary.databaseId,
                    query = query,
                    prefix = state.browsePath.takeUnless { it == "/" },
                    limit = 50u,
                    session = browseSession(database),
                )
            }.onSuccess { results ->
                _uiState.update { it.copy(browseSearchResults = results, message = "${results.size} results") }
            }.onFailure(::showError)
        }
    }

    fun enqueueUrl(url: String) {
        runCatching {
            inbox.enqueue(
                url = URI(url.trim()),
                databaseId = _uiState.value.selectedCaptureDatabaseId,
                outputLanguage = _uiState.value.generationLanguage,
            )
        }.onSuccess {
            _uiState.update { state ->
                state.copy(pendingUrls = inbox.loadPendingUrls(), message = "Queued.")
            }
        }.onFailure(::showError)
    }

    fun removePending(item: PendingSharedUrl) {
        inbox.remove(item)
        _uiState.update { it.copy(pendingUrls = inbox.loadPendingUrls()) }
    }

    fun submitNextPending() {
        val state = _uiState.value
        val session = state.session ?: run {
            _uiState.update { it.copy(message = "Sign in before submitting.") }
            return
        }
        val database = state.memberDatabases.firstOrNull {
            it.databaseId == state.selectedCaptureDatabaseId
        }
        viewModelScope.launch {
            _uiState.update { it.copy(message = "Submitting...") }
            val message = submitter.submitNextPendingUrl(session, database)
            _uiState.update {
                it.copy(pendingUrls = inbox.loadPendingUrls(), message = message)
            }
            refreshSourceCaptureHistory()
        }
    }

    fun refreshSourceCaptureHistory(refreshAll: Boolean = false) {
        val state = _uiState.value
        val databaseId = state.selectedCaptureDatabaseId
        if (databaseId.isBlank()) {
            _uiState.update { it.copy(sourceCaptureHistory = emptyList()) }
            return
        }
        val local = historyStore.load(databaseId)
        _uiState.update { it.copy(sourceCaptureHistory = local) }
        val session = state.session ?: return
        viewModelScope.launch {
            _uiState.update { it.copy(isLoadingSourceCaptureHistory = true) }
            val records = if (refreshAll) local else local.take(10)
            records.forEach { record ->
                val checkedAt = System.currentTimeMillis()
                val updated = runCatching {
                    val node = vfsClient.readBrowseNode(
                        databaseId,
                        record.item.requestPath,
                        session,
                    ) ?: throw IllegalStateException("Request node is no longer available.")
                    record.copy(
                        item = SourceCaptureHistoryParser.item(node).copy(
                            lastCheckedAtMilliseconds = checkedAt,
                            syncError = null,
                        ),
                    )
                }.getOrElse { error ->
                    record.copy(
                        item = record.item.copy(
                            lastCheckedAtMilliseconds = checkedAt,
                            syncError = errorMessage(error),
                        ),
                    )
                }
                runCatching { historyStore.save(updated) }
                _uiState.update { current ->
                    current.copy(
                        sourceCaptureHistory = current.sourceCaptureHistory.map {
                            if (it.id == updated.id) updated else it
                        },
                    )
                }
            }
            _uiState.update { it.copy(isLoadingSourceCaptureHistory = false) }
        }
    }

    fun retrySourceCapture(record: SourceCaptureHistoryRecord) {
        val state = _uiState.value
        val session = state.session ?: return
        if (record.databaseId != state.selectedCaptureDatabaseId) {
            _uiState.update { it.copy(message = "Select the database that owns this capture before retrying.") }
            return
        }
        if (!record.item.isRetryable() || record.item.requestPath in state.sourceCaptureRetryPaths) return
        _uiState.update {
            it.copy(sourceCaptureRetryPaths = it.sourceCaptureRetryPaths + record.item.requestPath)
        }
        viewModelScope.launch {
            runCatching {
                icClient.retrySourceCapture(record.databaseId, record.item.requestPath, session)
            }.onSuccess {
                _uiState.update { it.copy(message = "Capture retry started.") }
            }.onFailure { error ->
                _uiState.update { it.copy(message = "Capture retry failed: ${errorMessage(error)}") }
            }
            _uiState.update {
                it.copy(sourceCaptureRetryPaths = it.sourceCaptureRetryPaths - record.item.requestPath)
            }
            refreshSourceCaptureHistory(refreshAll = true)
        }
    }

    fun openCaptureDocument(record: SourceCaptureHistoryRecord) {
        val path = record.item.targetPath ?: return
        val entry = _uiState.value.browseDatabases.firstOrNull {
            it.summary.databaseId == record.databaseId
        } ?: return
        selectBrowseDatabase(entry.summary.databaseId)
        openBrowseNode(path)
        requestNavigation(KinicTopLevelDestination.BROWSE)
    }

    override suspend fun retrieve(databaseId: String, plan: AskAiQueryPlan): AskAiRetrievalResult {
        val database = _uiState.value.browseDatabases.firstOrNull {
            it.summary.databaseId == databaseId
        } ?: throw IllegalStateException("The selected database is no longer readable.")
        val session = browseSession(database)
        val hitsByQuery = plan.queries.associate { query ->
            query.text to vfsClient.searchBrowseNodes(
                databaseId = databaseId,
                query = query.text,
                prefix = null,
                limit = AskAiRetrievalPlanner.SEARCH_LIMIT_PER_QUERY,
                session = session,
            )
        }
        val sources = mutableListOf<AskAiContextSource>()
        for (candidate in AskAiRetrievalPlanner.rankedCandidates(plan, hitsByQuery)) {
            if (sources.size >= AskAiRetrievalPlanner.MAXIMUM_SOURCES) break
            val node = vfsClient.readBrowseNode(databaseId, candidate.hit.path, session) ?: continue
            if (!AskAiRetrievalPlanner.hasRequiredExactMatches(plan, node.content)) continue
            val prepared = AskAiRetrievalPlanner.prepareEvidence(plan, candidate.hit, node.content)
            val source = AskAiSource(
                id = "S${sources.size + 1}",
                path = node.path,
                excerpt = prepared.excerpt,
                score = candidate.bestScore,
                matchReasons = candidate.hit.matchReasons,
            )
            sources += AskAiContextSource(source, prepared.content)
        }
        return AskAiRetrievalResult(plan.queries.map { it.text }, sources)
    }

    override fun openSource(databaseId: String, path: String) {
        val database = _uiState.value.browseDatabases.firstOrNull {
            it.summary.databaseId == databaseId
        } ?: run {
            _uiState.update { it.copy(message = "The source database is no longer available.") }
            return
        }
        selectBrowseDatabase(database.summary.databaseId)
        openBrowseNode(path)
        requestNavigation(KinicTopLevelDestination.BROWSE)
    }

    fun selectManageDatabase(databaseId: String) {
        _uiState.update { it.copy(manage = ManageUiState(selectedDatabaseId = databaseId)) }
        refreshManageDetails()
    }

    fun refreshManageDetails() {
        val state = _uiState.value
        val session = state.session ?: return
        val databaseId = state.manage.selectedDatabaseId
            .ifBlank { manageableDatabases(state).firstOrNull()?.databaseId.orEmpty() }
        if (databaseId.isBlank()) return
        _uiState.update { it.copy(manage = it.manage.copy(selectedDatabaseId = databaseId, isLoading = true)) }
        viewModelScope.launch {
            runCatching {
                val page = vfsClient.listDatabaseCycleEntries(databaseId, null, 50u, session)
                ManageUiState(
                    selectedDatabaseId = databaseId,
                    members = vfsClient.listDatabaseMembers(databaseId, session),
                    cycleEntries = page.entries,
                    pendingPurchases = vfsClient.listDatabaseCyclesPendingPurchases(databaseId, session),
                    billingConfig = runCatching { vfsClient.getCyclesBillingConfig(session) }.getOrNull(),
                    nextCursor = page.nextCursor,
                )
            }.onSuccess { manage ->
                _uiState.update {
                    it.copy(
                        manage = manage,
                        message = "",
                    )
                }
            }.onFailure {
                _uiState.update { current ->
                    current.copy(
                        manage = current.manage.copy(isLoading = false),
                        message = errorMessage(it),
                    )
                }
            }
        }
    }

    fun loadNextCycleEntries() {
        val state = _uiState.value
        val cursor = state.manage.nextCursor ?: return
        loadCycleEntries(
            cursor = cursor,
            previousCursors = state.manage.previousCursors + state.manage.currentCursor,
        )
    }

    fun loadPreviousCycleEntries() {
        val state = _uiState.value
        if (state.manage.previousCursors.isEmpty()) return
        loadCycleEntries(
            cursor = state.manage.previousCursors.last(),
            previousCursors = state.manage.previousCursors.dropLast(1),
        )
    }

    fun createDatabase(name: String) {
        val session = _uiState.value.session ?: return
        val error = databaseNameError(name)
        if (error != null) {
            _uiState.update { it.copy(message = error) }
            return
        }
        runManageAction("create") {
            val created = vfsClient.createDatabase(name.trim(), session)
            settingsStore.selectedDatabaseId = created.databaseId
            settingsStore.selectedBrowseDatabaseId = created.databaseId
            _uiState.update {
                it.copy(
                    manage = it.manage.copy(
                        selectedDatabaseId = created.databaseId,
                        pendingFundingDatabaseId = created.databaseId.takeIf {
                            created.status == DatabaseStatus.PENDING
                        },
                    ),
                    message = if (created.status == DatabaseStatus.PENDING) {
                        "Database created and pending funding."
                    } else {
                        "Database created."
                    },
                )
            }
            refreshDatabases()
        }
    }

    fun updateDatabaseMetadata(name: String, description: String, llmSummary: String?, tagsJson: String) {
        val state = _uiState.value
        val session = state.session ?: return
        val database = manageableDatabases(state).firstOrNull {
            it.databaseId == state.manage.selectedDatabaseId
        } ?: return
        runManageAction("metadata") {
            vfsClient.updateDatabaseMetadata(
                database.databaseId,
                name.trim(),
                description.trim(),
                llmSummary?.trim()?.ifBlank { null },
                tagsJson,
                session,
            )
            _uiState.update { it.copy(message = "Metadata updated.") }
            refreshDatabases()
        }
    }

    fun grantDatabaseAccess(principal: String, role: DatabaseRole) {
        val state = _uiState.value
        val session = state.session ?: return
        val database = ownerManagedDatabase(state) ?: return
        runManageAction("grant") {
            vfsClient.grantDatabaseAccess(database.databaseId, principal.trim(), role, session)
            refreshManageDetails()
        }
    }

    fun revokeDatabaseAccess(principal: String) {
        val state = _uiState.value
        val session = state.session ?: return
        val database = ownerManagedDatabase(state) ?: return
        runManageAction("revoke") {
            vfsClient.revokeDatabaseAccess(database.databaseId, principal, session)
            refreshManageDetails()
        }
    }

    fun deleteDatabase(confirmation: String) {
        val state = _uiState.value
        val session = state.session ?: return
        val database = ownerManagedDatabase(state) ?: return
        if (confirmation.trim() != database.databaseId) {
            _uiState.update { it.copy(message = "Enter the exact Database ID to delete.") }
            return
        }
        runManageAction("delete") {
            vfsClient.deleteDatabase(database.databaseId, session)
            _uiState.update { it.copy(message = "Database deleted.", manage = ManageUiState()) }
            refreshDatabases()
        }
    }

    fun openFunding() {
        val databaseId = _uiState.value.manage.selectedDatabaseId
        if (databaseId.isNotBlank()) {
            _events.tryEmit(
                KinicAppEvent.OpenUri(configuration.authOrigin.resolve("/cycles?database_id=$databaseId")),
            )
        }
    }

    private fun runManageAction(name: String, block: suspend () -> Unit) {
        if (_uiState.value.manage.busyAction != null) return
        _uiState.update { it.copy(manage = it.manage.copy(busyAction = name)) }
        viewModelScope.launch {
            runCatching { block() }
                .onFailure(::showError)
            _uiState.update { it.copy(manage = it.manage.copy(busyAction = null)) }
        }
    }

    private fun loadCycleEntries(cursor: ULong?, previousCursors: List<ULong?>) {
        val state = _uiState.value
        val session = state.session ?: return
        val databaseId = state.manage.selectedDatabaseId
        if (databaseId.isBlank()) return
        _uiState.update { it.copy(manage = it.manage.copy(isLoading = true)) }
        viewModelScope.launch {
            runCatching {
                vfsClient.listDatabaseCycleEntries(databaseId, cursor, 50u, session)
            }.onSuccess { page ->
                _uiState.update {
                    it.copy(
                        manage = it.manage.copy(
                            cycleEntries = page.entries,
                            currentCursor = cursor,
                            nextCursor = page.nextCursor,
                            previousCursors = previousCursors,
                            isLoading = false,
                        ),
                    )
                }
            }.onFailure {
                _uiState.update { current ->
                    current.copy(
                        manage = current.manage.copy(isLoading = false),
                        message = errorMessage(it),
                    )
                }
            }
        }
    }

    private suspend fun loadPurchasedDatabaseIds(session: IcAuthSession): Set<String> {
        val ids = mutableSetOf<String>()
        var cursor: String? = null
        do {
            val page = vfsClient.marketListEntitlements(session, cursor, 100u)
            ids += page.entitlements.map(MarketEntitlement::databaseId)
            cursor = page.nextCursor
        } while (cursor != null)
        return ids
    }

    private fun selectedBrowseEntry(): BrowseDatabaseEntry? =
        _uiState.value.browseDatabases.firstOrNull {
            it.summary.databaseId == _uiState.value.selectedBrowseDatabaseId
        }

    private fun browseSession(database: BrowseDatabaseEntry): IcAuthSession? =
        _uiState.value.session.takeIf {
            BrowseDatabaseOrigin.MEMBER in database.origins ||
                BrowseDatabaseOrigin.PURCHASED in database.origins
        }

    private fun ownerManagedDatabase(state: KinicAppUiState): DatabaseSummary? {
        val database = manageableDatabases(state).firstOrNull {
            it.databaseId == state.manage.selectedDatabaseId
        }
        if (database?.role != DatabaseRole.OWNER) {
            _uiState.update { it.copy(message = "Owner access is required.") }
            return null
        }
        return database
    }

    private fun showError(error: Throwable) {
        _uiState.update { it.copy(message = errorMessage(error)) }
    }

    private fun requestNavigation(destination: KinicTopLevelDestination) {
        _uiState.update {
            it.copy(
                requestedDestination = destination,
                navigationRequestId = it.navigationRequestId + 1,
            )
        }
    }

    companion object {
        fun manageableDatabases(state: KinicAppUiState): List<DatabaseSummary> =
            state.memberDatabases.filter {
                it.role.canWrite && it.status != DatabaseStatus.DELETED
            }

        fun mergeBrowseDatabases(
            memberDatabases: List<DatabaseSummary>,
            publicDatabases: List<DatabaseSummary>,
            purchasedDatabaseIds: Set<String>,
            purchasedLookupSucceeded: Boolean,
            showPublic: Boolean,
            showPurchased: Boolean,
            directDatabaseIds: Set<String>,
        ): List<BrowseDatabaseEntry> {
            val entries = linkedMapOf<String, BrowseDatabaseEntry>()
            if (showPublic) {
                publicDatabases.filter(DatabaseSummary::canRead).forEach { database ->
                    entries[database.databaseId] = BrowseDatabaseEntry(
                        database,
                        setOf(BrowseDatabaseOrigin.PUBLIC),
                    )
                }
            }
            memberDatabases.filter(DatabaseSummary::canRead).forEach { database ->
                val isPurchased = database.databaseId in purchasedDatabaseIds
                if (!showPurchased && database.role == DatabaseRole.READER) {
                    if (!purchasedLookupSucceeded || isPurchased) return@forEach
                }
                val origins = buildSet {
                    add(BrowseDatabaseOrigin.MEMBER)
                    if (isPurchased) add(BrowseDatabaseOrigin.PURCHASED)
                    entries[database.databaseId]?.origins?.let(::addAll)
                }
                entries[database.databaseId] = BrowseDatabaseEntry(database, origins)
            }
            directDatabaseIds.forEach { databaseId ->
                val existing = entries[databaseId]
                entries[databaseId] = if (existing == null) {
                    BrowseDatabaseEntry(directDatabaseSummary(databaseId), setOf(BrowseDatabaseOrigin.DIRECT))
                } else {
                    existing.copy(origins = existing.origins + BrowseDatabaseOrigin.DIRECT)
                }
            }
            return entries.values.sortedBy { it.summary.displayTitle.lowercase() }
        }

        fun databaseNameError(name: String): String? {
            val trimmed = name.trim()
            if (trimmed.isEmpty()) return "Database name is required."
            if (trimmed.codePointCount(0, trimmed.length) > 80) return "Database name must be 1..80 characters."
            if (trimmed.any { it.code < 0x20 || it.code == 0x7f }) {
                return "Database name may not contain control characters."
            }
            return null
        }

        private fun directDatabaseSummary(databaseId: String): DatabaseSummary =
            DatabaseSummary(
                databaseId = databaseId,
                title = databaseId,
                description = "",
                metadata = null,
                role = DatabaseRole.READER,
                status = DatabaseStatus.ACTIVE,
                logicalSizeBytes = 0uL,
                cyclesBalance = null,
                cyclesSuspendedAtMs = null,
                deletedAtMs = null,
            )

        private fun normalizedPath(path: String): String {
            val segments = path.trim().split('/').filter(String::isNotBlank)
            return if (segments.isEmpty()) "/" else "/${segments.joinToString("/")}"
        }

        private fun parentPath(path: String): String {
            val normalized = normalizedPath(path)
            if (normalized == "/") return "/"
            return normalized.substringBeforeLast('/').ifBlank { "/" }
        }

        private fun sortChildren(children: List<ChildNode>, sort: BrowseSort): List<ChildNode> {
            val folderFirst = compareByDescending<ChildNode> { it.kind == VfsNodeKind.FOLDER }
            return when (sort) {
                BrowseSort.NAME -> children.sortedWith(folderFirst.thenBy { it.name.lowercase() })
                BrowseSort.MODIFIED -> children.sortedWith(
                    folderFirst.thenByDescending { it.updatedAt ?: Long.MIN_VALUE }.thenBy { it.name.lowercase() },
                )
            }
        }

        private fun errorMessage(error: Throwable): String =
            error.message ?: "Operation failed."
    }
}

class KinicAppViewModelFactory(
    private val configuration: AppConfiguration,
    private val authService: KinicAuthService,
    private val settingsStore: KinicSettingsStore,
    private val inbox: ShareInbox,
    private val submitter: SourceCaptureSubmitter,
    private val vfsClient: KinicVfsClient,
    private val historyStore: SourceCaptureHistoryStore,
    private val icClient: KinicIcClient,
) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T {
        require(modelClass.isAssignableFrom(KinicAppViewModel::class.java))
        return KinicAppViewModel(
            configuration,
            authService,
            settingsStore,
            inbox,
            submitter,
            vfsClient,
            historyStore,
            icClient,
        ) as T
    }
}
