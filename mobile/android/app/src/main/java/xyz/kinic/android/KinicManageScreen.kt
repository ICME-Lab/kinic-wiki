package xyz.kinic.android

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Dns
import androidx.compose.material.icons.outlined.History
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.ManageAccounts
import androidx.compose.material.icons.outlined.OpenInBrowser
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.Storage
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

@Composable
internal fun ManageScreen(state: KinicAppUiState, viewModel: KinicAppViewModel) {
    val databases = KinicAppViewModel.manageableDatabases(state)
    val database = databases.firstOrNull { it.databaseId == state.manage.selectedDatabaseId }
    var createDialog by remember { mutableStateOf(false) }
    var deleteDialog by remember { mutableStateOf(false) }
    var metadataDialog by remember { mutableStateOf(false) }
    var grantDialog by remember { mutableStateOf(false) }
    var revokePrincipal by remember { mutableStateOf<String?>(null) }
    val isBusy = state.manage.busyAction != null
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .verticalScroll(rememberScrollState())
            .padding(horizontal = KinicDesign.ScreenPadding, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        KinicFormSection(
            title = "Database",
            icon = Icons.Outlined.Storage,
            trailing = {
                IconButton(onClick = { createDialog = true }, enabled = state.session != null && !isBusy) {
                    Icon(Icons.Outlined.Add, contentDescription = "Create")
                }
            },
        ) {
            if (state.session == null) {
                KinicEmptyState(
                    icon = Icons.Outlined.Person,
                    title = "Sign in to manage",
                    detail = "Internet Identity unlocks database settings and access controls.",
                )
                KinicPrimaryButton(onClick = viewModel::startSignIn) {
                    Text("Sign in", fontWeight = FontWeight.SemiBold)
                }
            } else if (databases.isEmpty()) {
                KinicEmptyState(
                    icon = Icons.Outlined.Storage,
                    title = "No manageable databases",
                    detail = "Owner and Writer databases appear here.",
                )
            } else {
                DatabaseDropdown(
                    entries = databases.map { BrowseDatabaseEntry(it, setOf(BrowseDatabaseOrigin.MEMBER)) },
                    selectedId = state.manage.selectedDatabaseId,
                    onSelect = viewModel::selectManageDatabase,
                    label = "Managed database",
                )
            }
        }
        state.manage.pendingFundingDatabaseId?.let { pendingDatabaseId ->
            KinicFormSection(title = "Pending activation", icon = Icons.Outlined.Info) {
                Text("Database $pendingDatabaseId is waiting for funding.")
                Button(onClick = { viewModel.openFunding(pendingDatabaseId) }, enabled = !isBusy) {
                    Icon(Icons.Outlined.OpenInBrowser, contentDescription = null)
                    Spacer(Modifier.width(8.dp))
                    Text("Fund database")
                }
            }
        }
        if (database != null) {
            KinicFormSection(
                title = "Database",
                icon = Icons.Outlined.Dns,
                trailing = {
                    IconButton(onClick = viewModel::refreshManageDetails) {
                        Icon(Icons.Outlined.Refresh, contentDescription = "Refresh")
                    }
                },
            ) {
                ManagementValue("Role", database.role.candidName)
                ManagementValue("Status", database.status.candidName)
                ManagementValue("Database ID", database.databaseId)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = { metadataDialog = true }, enabled = !isBusy) {
                        Text("Edit metadata")
                    }
                    IconButton(onClick = { viewModel.openFunding(database.databaseId) }) {
                        Icon(Icons.Outlined.OpenInBrowser, contentDescription = "Funding")
                    }
                }
            }
            KinicFormSection(
                title = "Access",
                icon = Icons.Outlined.ManageAccounts,
                trailing = if (database.role == DatabaseRole.OWNER) {
                    {
                        IconButton(onClick = { grantDialog = true }, enabled = !isBusy) {
                            Icon(Icons.Outlined.Add, contentDescription = "Grant access")
                        }
                    }
                } else null,
            ) {
                if (state.manage.members.isEmpty()) {
                    Text("No members.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                state.manage.members.forEachIndexed { index, member ->
                    Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Column(modifier = Modifier.weight(1f)) {
                            Text(member.role.candidName, fontWeight = FontWeight.Medium)
                            Text(
                                compactPrincipal(member.principal),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        if (database.role == DatabaseRole.OWNER && member.principal != state.session?.principal) {
                            IconButton(onClick = { revokePrincipal = member.principal }, enabled = !isBusy) {
                                Icon(Icons.Outlined.Delete, contentDescription = "Revoke access")
                            }
                        }
                    }
                    if (index != state.manage.members.lastIndex) HorizontalDivider()
                }
            }
            KinicFormSection(title = "Cycles", icon = Icons.Outlined.History) {
                ManagementValue("Logical size", "${database.logicalSizeBytes} bytes")
                ManagementValue("Cycles balance", database.cyclesBalance?.let { "$it cycles" } ?: "Unavailable")
                ManagementValue("Suspended since", database.cyclesSuspendedAtMs?.toString() ?: "Not suspended")
            }
            KinicFormSection(title = "Cycle ledger", icon = Icons.Outlined.History) {
                if (state.manage.cycleEntries.isEmpty()) {
                    Text("No cycle entries.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                state.manage.cycleEntries.forEach { entry ->
                    ManagementValue(entry.kind, entry.amountCycles.toString())
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(
                        onClick = viewModel::loadPreviousCycleEntries,
                        enabled = state.manage.previousCursors.isNotEmpty() && !state.manage.isLoading,
                    ) { Text("Previous") }
                    OutlinedButton(
                        onClick = viewModel::loadNextCycleEntries,
                        enabled = state.manage.nextCursor != null && !state.manage.isLoading,
                    ) { Text("Next") }
                }
            }
            if (state.manage.pendingPurchases.isNotEmpty()) {
                KinicFormSection(title = "Pending purchases", icon = Icons.Outlined.Info) {
                    state.manage.pendingPurchases.forEach { purchase ->
                        ManagementValue(purchase.status, purchase.requiredAction)
                    }
                }
            }
            if (database.role == DatabaseRole.OWNER) {
                Column(verticalArrangement = Arrangement.spacedBy(7.dp)) {
                    Text(
                        "Danger zone",
                        modifier = Modifier.padding(horizontal = 16.dp),
                        style = MaterialTheme.typography.labelLarge,
                        color = MaterialTheme.colorScheme.error,
                    )
                    Surface(
                        modifier = Modifier.fillMaxWidth(),
                        shape = KinicDesign.ControlShape,
                        color = MaterialTheme.colorScheme.errorContainer,
                    ) {
                    Row(modifier = Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(modifier = Modifier.weight(1f)) {
                            Text("Delete database", fontWeight = FontWeight.SemiBold)
                            Text("Deleting a database cannot be undone.", style = MaterialTheme.typography.bodySmall)
                        }
                        TextButton(onClick = { deleteDialog = true }, enabled = !isBusy) { Text("Delete") }
                    }
                    }
                }
            }
        }
        if (state.message.isNotBlank()) {
            Text(state.message, color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.bodySmall)
        }
        Spacer(Modifier.height(8.dp))
    }
    if (createDialog) {
        CreateDatabaseDialog(
            onDismiss = { createDialog = false },
            onCreate = {
                createDialog = false
                viewModel.createDatabase(it)
            },
        )
    }
    if (deleteDialog && database != null) {
        DeleteDatabaseDialog(
            databaseId = database.databaseId,
            onDismiss = { deleteDialog = false },
            onDelete = {
                deleteDialog = false
                viewModel.deleteDatabase(it)
            },
        )
    }
    if (metadataDialog && database != null) {
        MetadataDialog(
            database = database,
            onDismiss = { metadataDialog = false },
            onSave = { name, description, summary, tags ->
                metadataDialog = false
                viewModel.updateDatabaseMetadata(name, description, summary, tags)
            },
        )
    }
    if (grantDialog) {
        GrantAccessDialog(
            onDismiss = { grantDialog = false },
            onGrant = { principal, role ->
                grantDialog = false
                viewModel.grantDatabaseAccess(principal, role)
            },
        )
    }
    revokePrincipal?.let { principal ->
        AlertDialog(
            onDismissRequest = { revokePrincipal = null },
            title = { Text("Revoke access") },
            text = { Text(principal) },
            confirmButton = {
                Button(
                    onClick = {
                        revokePrincipal = null
                        viewModel.revokeDatabaseAccess(principal)
                    },
                ) { Text("Revoke") }
            },
            dismissButton = { TextButton(onClick = { revokePrincipal = null }) { Text("Cancel") } },
        )
    }
}
