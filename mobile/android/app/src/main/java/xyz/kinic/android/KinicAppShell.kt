package xyz.kinic.android

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.Home
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.Tune
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import java.net.URI

@Composable
fun KinicAppShell(
    viewModel: KinicAppViewModel,
    askAiViewModel: AskAiViewModel,
    onOpenUri: (URI) -> Unit,
    onCopyText: (String, String) -> Unit,
) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    val useDark = when (state.darkMode) {
        DarkMode.SYSTEM -> androidx.compose.foundation.isSystemInDarkTheme()
        DarkMode.LIGHT -> false
        DarkMode.DARK -> true
    }
    LaunchedEffect(viewModel) {
        viewModel.events.collect { event ->
            when (event) {
                is KinicAppEvent.OpenUri -> onOpenUri(event.uri)
                is KinicAppEvent.CopyText -> onCopyText(event.label, event.value)
            }
        }
    }
    KinicTheme(useDark = useDark) {
        KinicNavigation(state, viewModel, askAiViewModel)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun KinicNavigation(
    state: KinicAppUiState,
    viewModel: KinicAppViewModel,
    askAiViewModel: AskAiViewModel,
) {
    val navController = rememberNavController()
    val backStack by navController.currentBackStackEntryAsState()
    val route = backStack?.destination?.route ?: KinicTopLevelDestination.HOME.route
    var showIngest by remember { mutableStateOf(false) }
    var showSettings by remember { mutableStateOf(false) }
    LaunchedEffect(state.navigationRequestId, navController) {
        if (state.navigationRequestId > 0) {
            navController.navigate(state.requestedDestination.route) {
                popUpTo(KinicTopLevelDestination.HOME.route) { saveState = true }
                launchSingleTop = true
                restoreState = true
            }
        }
    }
    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    if (route == KinicTopLevelDestination.HOME.route) {
                        KinicHeaderTitle()
                    } else {
                        Text(
                            KinicTopLevelDestination.entries.firstOrNull { it.route == route }?.label ?: "KinicWiki",
                            fontWeight = FontWeight.SemiBold,
                        )
                    }
                },
                actions = {
                    when (route) {
                        KinicTopLevelDestination.HOME.route -> {
                            IconButton(onClick = { showIngest = true }) {
                                Icon(Icons.Outlined.Link, contentDescription = "Ingest")
                            }
                            IconButton(onClick = { showSettings = true }) {
                                Icon(Icons.Outlined.Settings, contentDescription = "Settings")
                            }
                        }
                        KinicTopLevelDestination.BROWSE.route,
                        KinicTopLevelDestination.MANAGE.route,
                        -> IconButton(onClick = viewModel::refreshDatabases) {
                            Icon(Icons.Outlined.Refresh, contentDescription = "Refresh databases")
                        }
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surface,
                    actionIconContentColor = MaterialTheme.colorScheme.primary,
                ),
            )
        },
        bottomBar = {
            NavigationBar(containerColor = MaterialTheme.colorScheme.surface) {
                KinicTopLevelDestination.entries.forEach { destination ->
                    NavigationBarItem(
                        selected = route == destination.route,
                        onClick = {
                            navController.navigate(destination.route) {
                                popUpTo(KinicTopLevelDestination.HOME.route) { saveState = true }
                                launchSingleTop = true
                                restoreState = true
                            }
                        },
                        icon = {
                            Icon(
                                when (destination) {
                                    KinicTopLevelDestination.HOME -> Icons.Outlined.Home
                                    KinicTopLevelDestination.BROWSE -> Icons.Outlined.Folder
                                    KinicTopLevelDestination.ASK_AI -> Icons.Outlined.AutoAwesome
                                    KinicTopLevelDestination.MANAGE -> Icons.Outlined.Tune
                                },
                                contentDescription = null,
                            )
                        },
                        label = { Text(destination.label) },
                        colors = NavigationBarItemDefaults.colors(
                            selectedIconColor = MaterialTheme.colorScheme.primary,
                            selectedTextColor = MaterialTheme.colorScheme.primary,
                            indicatorColor = MaterialTheme.colorScheme.primary.copy(alpha = 0.12f),
                        ),
                    )
                }
            }
        },
    ) { padding ->
        NavHost(
            navController = navController,
            startDestination = KinicTopLevelDestination.HOME.route,
            modifier = Modifier.padding(padding),
        ) {
            composable(KinicTopLevelDestination.HOME.route) { HomeScreen(state, viewModel) }
            composable(KinicTopLevelDestination.BROWSE.route) { BrowseScreen(state, viewModel) }
            composable(KinicTopLevelDestination.ASK_AI.route) { AskAiScreen(state, askAiViewModel) }
            composable(KinicTopLevelDestination.MANAGE.route) { ManageScreen(state, viewModel) }
        }
    }
    if (showIngest) {
        ModalBottomSheet(onDismissRequest = { showIngest = false }) {
            IngestSheet(
                state = state,
                viewModel = viewModel,
                onSubmitted = { showIngest = false },
            )
        }
    }
    if (showSettings) {
        ModalBottomSheet(onDismissRequest = { showSettings = false }) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = KinicDesign.ScreenPadding)
                    .padding(bottom = 32.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                Text("Settings", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                SettingsPanel(state, viewModel)
            }
        }
    }
}
