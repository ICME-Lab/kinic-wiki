package xyz.kinic.android

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import org.junit.Rule
import org.junit.Test

class MainActivityTest {
    @get:Rule
    val composeRule = createAndroidComposeRule<MainActivity>()

    @Test
    fun navigatesAcrossFourTopLevelDestinations() {
        composeRule.onNodeWithText("Home").assertIsDisplayed()

        composeRule.onNodeWithText("Browse").performClick()
        composeRule.onNodeWithText("Database ID").assertIsDisplayed()

        composeRule.onNodeWithText("Ask AI").performClick()
        composeRule.onNodeWithText("Ask a question").assertIsDisplayed()

        composeRule.onNodeWithText("Manage").performClick()
        composeRule.onNodeWithText("Create").assertIsDisplayed()
    }
}
