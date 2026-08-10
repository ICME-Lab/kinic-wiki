package xyz.kinic.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class KinicUiReferenceTest {
    @Test
    fun exposesDeterministicReferenceStateForEachTopLevelScreen() {
        val home = requireNotNull(kinicUiReferenceFixture("home"))
        val browse = requireNotNull(kinicUiReferenceFixture("browse"))
        val askAi = requireNotNull(kinicUiReferenceFixture("ask-ai"))
        val manage = requireNotNull(kinicUiReferenceFixture("manage"))

        assertEquals(KinicTopLevelDestination.HOME, home.destination)
        assertNull(home.appState.session)

        assertEquals(KinicTopLevelDestination.BROWSE, browse.destination)
        assertFalse(browse.appState.browseChildren.isEmpty())

        assertEquals(KinicTopLevelDestination.ASK_AI, askAi.destination)
        assertFalse(askAi.askState.messages.isEmpty())

        assertEquals(KinicTopLevelDestination.MANAGE, manage.destination)
        assertNotNull(manage.appState.session)
        assertFalse(manage.appState.manage.members.isEmpty())
    }

    @Test
    fun ignoresUnknownReferenceMode() {
        assertNull(kinicUiReferenceFixture("unknown"))
        assertNull(kinicUiReferenceFixture(null))
    }
}
