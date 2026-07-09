// Where: mobile/android/app/src/main/java/xyz/kinic/android/KinicUi.kt
// What: Compose shell for Android capture queue operations.
// Why: The first Android port needs a native entry screen before auth and browse are wired.

package xyz.kinic.android

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import java.net.URI

private val kinicPink = Color(0xFFE9368F)
private val kinicInk = Color(0xFF111116)

@Composable
fun KinicAppView(
    inbox: ShareInbox,
    initialMessage: String? = null,
) {
    var pending by remember { mutableStateOf(inbox.loadPendingUrls()) }
    var databaseId by remember { mutableStateOf("") }
    var urlText by remember { mutableStateOf("") }
    var message by remember { mutableStateOf(initialMessage ?: "") }

    MaterialTheme(
        colorScheme = MaterialTheme.colorScheme.copy(primary = kinicPink, onPrimary = Color.White),
    ) {
        Surface(modifier = Modifier.fillMaxSize(), color = Color.White, contentColor = kinicInk) {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(20.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                Text("KinicWiki", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
                OutlinedTextField(
                    value = databaseId,
                    onValueChange = { databaseId = it },
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("Database ID") },
                    singleLine = true,
                )
                OutlinedTextField(
                    value = urlText,
                    onValueChange = { urlText = it },
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("URL") },
                    singleLine = true,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Button(
                        onClick = {
                            runCatching {
                                inbox.enqueue(
                                    url = URI(urlText),
                                    databaseId = databaseId,
                                )
                            }.onSuccess {
                                urlText = ""
                                pending = inbox.loadPendingUrls()
                                message = "Queued"
                            }.onFailure {
                                message = it.message ?: "Failed"
                            }
                        },
                    ) {
                        Text("Queue")
                    }
                    TextButton(
                        onClick = {
                            pending = inbox.loadPendingUrls()
                            message = ""
                        },
                    ) {
                        Text("Refresh")
                    }
                }
                if (message.isNotBlank()) {
                    Text(message, color = kinicPink)
                }
                Spacer(Modifier.height(4.dp))
                Text("Pending", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    items(pending, key = { it.id }) { item ->
                        Column(
                            modifier = Modifier.fillMaxWidth(),
                            verticalArrangement = Arrangement.spacedBy(4.dp),
                        ) {
                            Text(item.url.toString(), style = MaterialTheme.typography.bodyMedium)
                            Text(item.requestId, style = MaterialTheme.typography.bodySmall, color = Color(0xFF66666F))
                            TextButton(
                                onClick = {
                                    inbox.remove(item)
                                    pending = inbox.loadPendingUrls()
                                },
                            ) {
                                Text("Remove")
                            }
                        }
                    }
                }
            }
        }
    }
}
