package xyz.kinic.android

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.OpenInBrowser
import androidx.compose.material.icons.outlined.Storage
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuAnchorType
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

@Composable
internal fun KinicEmptyState(icon: ImageVector, title: String, detail: String) {
    Column(
        modifier = Modifier.fillMaxWidth().padding(vertical = 18.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Icon(icon, contentDescription = null, modifier = Modifier.size(34.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(title, fontWeight = FontWeight.SemiBold)
        Text(
            detail,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.bodySmall,
            textAlign = TextAlign.Center,
        )
    }
}

@Composable
internal fun DatabaseSelectionRow(
    database: DatabaseSummary,
    origins: Set<BrowseDatabaseOrigin>,
    selected: Boolean,
    onClick: () -> Unit,
) {
    Surface(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick),
        shape = KinicDesign.ControlShape,
        color = if (selected) MaterialTheme.colorScheme.primary.copy(alpha = 0.08f) else MaterialTheme.colorScheme.surface,
        border = androidx.compose.foundation.BorderStroke(
            width = 1.dp,
            color = if (selected) MaterialTheme.colorScheme.primary.copy(alpha = 0.35f) else MaterialTheme.colorScheme.outline,
        ),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Icon(
                Icons.Outlined.Storage,
                contentDescription = null,
                tint = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        database.displayTitle,
                        modifier = Modifier.weight(1f),
                        fontWeight = FontWeight.SemiBold,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                    origins.filter { it != BrowseDatabaseOrigin.MEMBER }.forEach { origin ->
                        Spacer(Modifier.width(5.dp))
                        KinicBadge(origin.name.lowercase().replaceFirstChar(Char::uppercase))
                    }
                }
                Text(
                    database.role.candidName,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Icon(
                Icons.Outlined.Check,
                contentDescription = if (selected) "Selected" else null,
                tint = if (selected) MaterialTheme.colorScheme.primary else Color.Transparent,
            )
        }
    }
}

@Composable
internal fun ManagementValue(label: String, value: String) {
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(label, modifier = Modifier.weight(1f), color = MaterialTheme.colorScheme.onSurfaceVariant)
        SelectionContainer {
            Text(
                value,
                modifier = Modifier.weight(1f),
                fontWeight = FontWeight.Medium,
                textAlign = TextAlign.End,
                maxLines = 2,
                overflow = TextOverflow.MiddleEllipsis,
            )
        }
    }
}

@Composable
internal fun SettingsPanel(state: KinicAppUiState, viewModel: KinicAppViewModel) {
    Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
        SettingSwitch("Show public databases", state.showPublicDatabases, viewModel::setShowPublicDatabases)
        SettingSwitch("Show purchased databases", state.showPurchasedDatabases, viewModel::setShowPurchasedDatabases)
        Text("Appearance", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            DarkMode.entries.forEach { mode ->
                FilterChip(
                    selected = state.darkMode == mode,
                    onClick = { viewModel.setDarkMode(mode) },
                    label = { Text(mode.name.lowercase().replaceFirstChar(Char::uppercase)) },
                )
            }
        }
        LanguageDropdown(state.generationLanguage, viewModel::setGenerationLanguage)
        TextButton(onClick = viewModel::openPrivacyPolicy) {
            Icon(Icons.Outlined.OpenInBrowser, contentDescription = null)
            Spacer(Modifier.width(8.dp))
            Text("Privacy policy")
        }
    }
}

@Composable
private fun SettingSwitch(label: String, checked: Boolean, onCheckedChange: (Boolean) -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label)
        Switch(checked = checked, onCheckedChange = onCheckedChange)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun LanguageDropdown(selected: WikiOutputLanguage, onSelect: (WikiOutputLanguage) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    ExposedDropdownMenuBox(expanded = expanded, onExpandedChange = { expanded = it }) {
        OutlinedTextField(
            value = selected.displayName,
            onValueChange = {},
            readOnly = true,
            modifier = Modifier
                .menuAnchor(ExposedDropdownMenuAnchorType.PrimaryNotEditable)
                .fillMaxWidth(),
            label = { Text("Generation language") },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded) },
        )
        ExposedDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            WikiOutputLanguage.entries.forEach { language ->
                DropdownMenuItem(
                    text = { Text(language.displayName) },
                    onClick = {
                        expanded = false
                        onSelect(language)
                    },
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun DatabaseDropdown(
    entries: List<BrowseDatabaseEntry>,
    selectedId: String,
    onSelect: (String) -> Unit,
    label: String,
) {
    var expanded by remember { mutableStateOf(false) }
    val selected = entries.firstOrNull { it.summary.databaseId == selectedId }
    ExposedDropdownMenuBox(expanded = expanded, onExpandedChange = { expanded = it }) {
        OutlinedTextField(
            value = selected?.summary?.displayTitle ?: "",
            onValueChange = {},
            readOnly = true,
            modifier = Modifier
                .menuAnchor(ExposedDropdownMenuAnchorType.PrimaryNotEditable)
                .fillMaxWidth(),
            label = { Text(label) },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded) },
        )
        ExposedDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            entries.forEach { entry ->
                DropdownMenuItem(
                    text = {
                        Column {
                            Text(entry.summary.displayTitle)
                            Text(
                                entry.origins.joinToString(" · ") { it.name.lowercase() },
                                style = MaterialTheme.typography.bodySmall,
                            )
                        }
                    },
                    onClick = {
                        expanded = false
                        onSelect(entry.summary.databaseId)
                    },
                )
            }
        }
    }
}

@Composable
internal fun CreateDatabaseDialog(onDismiss: () -> Unit, onCreate: (String) -> Unit) {
    var name by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Create database") },
        text = { OutlinedTextField(value = name, onValueChange = { name = it }, label = { Text("Name") }) },
        confirmButton = { Button(onClick = { onCreate(name) }) { Text("Create") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
internal fun DeleteDatabaseDialog(databaseId: String, onDismiss: () -> Unit, onDelete: (String) -> Unit) {
    var confirmation by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Delete database") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(databaseId)
                OutlinedTextField(
                    value = confirmation,
                    onValueChange = { confirmation = it },
                    label = { Text("Database ID") },
                )
            }
        },
        confirmButton = {
            Button(onClick = { onDelete(confirmation) }, enabled = confirmation == databaseId) { Text("Delete") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
internal fun MetadataDialog(
    database: DatabaseSummary,
    onDismiss: () -> Unit,
    onSave: (String, String, String?, String) -> Unit,
) {
    var name by remember(database.databaseId) { mutableStateOf(database.metadata?.name ?: database.title) }
    var description by remember(database.databaseId) { mutableStateOf(database.metadata?.description ?: database.description) }
    var summary by remember(database.databaseId) { mutableStateOf(database.metadata?.llmSummary.orEmpty()) }
    var tags by remember(database.databaseId) { mutableStateOf(database.metadata?.tagsJson ?: "[]") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Edit metadata") },
        text = {
            Column(
                modifier = Modifier.verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                OutlinedTextField(name, { name = it }, label = { Text("Name") })
                OutlinedTextField(description, { description = it }, label = { Text("Description") })
                OutlinedTextField(summary, { summary = it }, label = { Text("LLM summary") })
                OutlinedTextField(tags, { tags = it }, label = { Text("Tags JSON") })
            }
        },
        confirmButton = { Button(onClick = { onSave(name, description, summary, tags) }) { Text("Save") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
internal fun GrantAccessDialog(onDismiss: () -> Unit, onGrant: (String, DatabaseRole) -> Unit) {
    var principal by remember { mutableStateOf("") }
    var role by remember { mutableStateOf(DatabaseRole.READER) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Grant database access") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = principal,
                    onValueChange = { principal = it },
                    label = { Text("Principal") },
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf(DatabaseRole.WRITER, DatabaseRole.READER).forEach { candidate ->
                        FilterChip(
                            selected = role == candidate,
                            onClick = { role = candidate },
                            label = { Text(candidate.candidName) },
                        )
                    }
                }
            }
        },
        confirmButton = {
            Button(onClick = { onGrant(principal.trim(), role) }, enabled = principal.isNotBlank()) { Text("Grant") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

internal fun compactPrincipal(principal: String): String =
    if (principal.length <= 24) principal else "${principal.take(12)}…${principal.takeLast(8)}"
