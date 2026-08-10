package xyz.kinic.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.URI

class KinicDeepLinkParserTest {
    @Test
    fun parsesSupportedRoutes() {
        assertTrue(
            KinicDeepLinkParser.parse(URI("https://wiki.kinic.xyz/native-auth-callback#message=m&state=s")) is
                KinicDestination.AuthCallback,
        )
        assertEquals(
            KinicDestination.Database("database-id", "/folder/Page.md"),
            KinicDeepLinkParser.parse(URI("https://wiki.kinic.xyz/db/database-id/folder/Page.md")),
        )
        assertEquals(KinicDestination.Database("database-id", "/"), KinicDeepLinkParser.parse(
            URI("https://wiki.kinic.xyz/db/database-id"),
        ))
        assertEquals(KinicDestination.Dashboard, KinicDeepLinkParser.parse(URI("https://wiki.kinic.xyz/dashboard")))
        assertEquals(KinicDestination.Profile, KinicDeepLinkParser.parse(URI("https://wiki.kinic.xyz/profile")))
        assertEquals(
            KinicDestination.Cycles("db id", "pending"),
            KinicDeepLinkParser.parse(
                URI("https://wiki.kinic.xyz/cycles?database_id=db%20id&status=pending"),
            ),
        )
        assertEquals(KinicDestination.Root, KinicDeepLinkParser.parse(URI("https://wiki.kinic.xyz/")))
    }

    @Test
    fun rejectsForeignOriginsCredentialsPortsAndUnknownPaths() {
        assertNull(KinicDeepLinkParser.parse(URI("http://wiki.kinic.xyz/dashboard")))
        assertNull(KinicDeepLinkParser.parse(URI("https://evil.example/dashboard")))
        assertNull(KinicDeepLinkParser.parse(URI("https://user@wiki.kinic.xyz/dashboard")))
        assertNull(KinicDeepLinkParser.parse(URI("https://wiki.kinic.xyz:443/dashboard")))
        assertNull(KinicDeepLinkParser.parse(URI("https://wiki.kinic.xyz/ios-auth-callback")))
        assertNull(KinicDeepLinkParser.parse(URI("https://wiki.kinic.xyz/android-auth-callback")))
        assertNull(KinicDeepLinkParser.parse(URI("https://wiki.kinic.xyz/unknown")))
    }
}
