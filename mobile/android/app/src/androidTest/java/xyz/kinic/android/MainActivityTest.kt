package xyz.kinic.android

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
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
        composeRule.onNodeWithContentDescription("Create").assertIsDisplayed()
    }

    @Test
    fun invalidManualUrlKeepsIngestSheetOpen() {
        composeRule.onNodeWithContentDescription("Ingest").performClick()
        composeRule.onNodeWithText("https://example.com/article").performTextInput("not a URL")
        composeRule.onNodeWithContentDescription("Send").performClick()

        composeRule.onNodeWithText("not a URL").assertIsDisplayed()
        composeRule.onAllNodesWithText("Ingest").assertCountEquals(2)
        composeRule.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }
    }

    @Test
    fun durableManualUrlClosesSheetAndShowsRetryablePendingRow() {
        composeRule.onNodeWithContentDescription("Ingest").performClick()
        composeRule.onNodeWithText("https://example.com/article")
            .performTextInput("https://example.com/android-ui-test")
        composeRule.onNodeWithContentDescription("Send").performClick()
        composeRule.waitForIdle()

        composeRule.onAllNodesWithText("Ingest").assertCountEquals(0)
        composeRule.onNodeWithText("Sign in before submitting.").performScrollTo().assertIsDisplayed()
        composeRule.onNodeWithText("Retry").performScrollTo().assertIsDisplayed()
        composeRule.onNodeWithContentDescription("Remove").performClick()
    }

    @Test
    fun routesIncomingDatabaseDeepLinkToBrowse() {
        openDeepLink("https://wiki.kinic.xyz/db/direct-database/folder/Page.md")

        composeRule.waitForIdle()
        composeRule.onNodeWithText("Database ID").assertIsDisplayed()
    }

    @Test
    fun routesDashboardAndCyclesToManage() {
        openDeepLink("https://wiki.kinic.xyz/dashboard")
        composeRule.onNodeWithContentDescription("Create").assertIsDisplayed()

        openDeepLink("https://wiki.kinic.xyz/cycles?database_id=direct-database&status=pending")
        composeRule.onNodeWithContentDescription("Create").assertIsDisplayed()
    }

    @Test
    fun routesProfileAndRootToHome() {
        openDeepLink("https://wiki.kinic.xyz/profile")
        composeRule.onNodeWithText("KinicWiki").assertIsDisplayed()

        openDeepLink("https://wiki.kinic.xyz/")
        composeRule.onNodeWithText("KinicWiki").assertIsDisplayed()
    }

    @Test
    fun authCallbackWithoutPendingRequestFailsWithoutLeavingHome() {
        openDeepLink("https://wiki.kinic.xyz/android-auth-callback?state=unexpected&result=invalid")

        composeRule.onNodeWithText("KinicWiki").assertIsDisplayed()
    }

    @Test
    fun ignoresForeignAndInsecureDeepLinks() {
        openDeepLink("https://evil.example/dashboard")
        composeRule.onNodeWithText("KinicWiki").assertIsDisplayed()

        openDeepLink("http://wiki.kinic.xyz/dashboard")
        composeRule.onNodeWithText("KinicWiki").assertIsDisplayed()
    }

    private fun openDeepLink(value: String) {
        composeRule.activityRule.scenario.onActivity {
            it.handleDeepLink(URI(value))
        }
        composeRule.waitForIdle()
    }
}
