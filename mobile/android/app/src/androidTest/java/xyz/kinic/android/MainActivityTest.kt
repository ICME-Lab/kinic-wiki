package xyz.kinic.android

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import org.junit.Rule
import org.junit.Test
import java.net.URI

class MainActivityTest {
    @get:Rule
    val composeRule = createAndroidComposeRule<MainActivity>()

    @Test
    fun navigatesAcrossFourTopLevelDestinations() {
        composeRule.onNode(hasText("Home") and hasClickAction()).assertIsDisplayed()

        composeRule.onNodeWithText("Browse").performClick()
        composeRule.onNodeWithText("Database ID").assertIsDisplayed()

        composeRule.onNodeWithText("Ask AI").performClick()
        composeRule.onNodeWithText("Ask a question").assertIsDisplayed()

        composeRule.onNodeWithText("Manage").performClick()
        composeRule.onNodeWithText("Create").assertIsDisplayed()
    }

    @Test
    fun routesIncomingDatabaseDeepLinkToBrowse() {
        composeRule.activityRule.scenario.onActivity {
            it.handleDeepLink(URI("https://wiki.kinic.xyz/db/direct-database/folder/Page.md"))
        }

        composeRule.waitForIdle()
        composeRule.onNodeWithText("Database ID").assertIsDisplayed()
    }
}
