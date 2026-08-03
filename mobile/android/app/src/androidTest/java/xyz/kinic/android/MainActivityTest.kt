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
        openDeepLink("https://wiki.kinic.xyz/db/direct-database/folder/Page.md")

        composeRule.waitForIdle()
        composeRule.onNodeWithText("Database ID").assertIsDisplayed()
    }

    @Test
    fun routesDashboardAndCyclesToManage() {
        openDeepLink("https://wiki.kinic.xyz/dashboard")
        composeRule.onNodeWithText("Create").assertIsDisplayed()

        openDeepLink("https://wiki.kinic.xyz/cycles?database_id=direct-database&status=pending")
        composeRule.onNodeWithText("Create").assertIsDisplayed()
    }

    @Test
    fun routesProfileAndRootToHome() {
        openDeepLink("https://wiki.kinic.xyz/profile")
        composeRule.onNodeWithText("Account").assertIsDisplayed()

        openDeepLink("https://wiki.kinic.xyz/")
        composeRule.onNodeWithText("Account").assertIsDisplayed()
    }

    @Test
    fun authCallbackWithoutPendingRequestFailsWithoutLeavingHome() {
        openDeepLink("https://wiki.kinic.xyz/android-auth-callback?state=unexpected&result=invalid")

        composeRule.onNodeWithText("Account").assertIsDisplayed()
    }

    @Test
    fun ignoresForeignAndInsecureDeepLinks() {
        openDeepLink("https://evil.example/dashboard")
        composeRule.onNodeWithText("Account").assertIsDisplayed()

        openDeepLink("http://wiki.kinic.xyz/dashboard")
        composeRule.onNodeWithText("Account").assertIsDisplayed()
    }

    private fun openDeepLink(value: String) {
        composeRule.activityRule.scenario.onActivity {
            it.handleDeepLink(URI(value))
        }
        composeRule.waitForIdle()
    }
}
