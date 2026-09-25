import XCTest

final class HomeNavigationUITests: XCTestCase {
    @MainActor private func launch(state: String = "ready", large: Bool = false, dark: Bool = false) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["KINIC_SCREENSHOT_MODE"] = "navigation"
        app.launchEnvironment["KINIC_NAV_STATE"] = state
        app.launchEnvironment["KINIC_LARGE_TEXT"] = large ? "1" : "0"
        app.launchEnvironment["KINIC_DARK_MODE"] = dark ? "1" : "0"
        app.launch()
        XCTAssertTrue(app.buttons["database.choose"].firstMatch.waitForExistence(timeout: 10))
        return app
    }
    @MainActor private func capture(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
    @MainActor func testDirectHistoryDatabaseSwitchAndScreenshots() {
        let app = launch()
        XCTAssertTrue(app.staticTexts["Plan the next research session"].waitForExistence(timeout: 10))
        capture(app, "01-home")
        app.buttons["home.captureHistory"].tap()
        XCTAssertTrue(app.navigationBars["Capture history"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["https://example.com/research-notes"].exists)
        capture(app, "02-capture-history")
        app.buttons["Done"].tap()
        app.buttons["database.choose"].firstMatch.tap()
        XCTAssertTrue(app.navigationBars["Databases"].waitForExistence(timeout: 5))
        capture(app, "03-databases")
        app.buttons.containing(NSPredicate(format: "label BEGINSWITH %@", "Team Research")).firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Your work starts here"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["Plan the next research session"].exists)
        for tab in ["Browse", "Ask AI", "Manage"] {
            app.buttons[tab].firstMatch.tap()
            XCTAssertTrue(app.buttons["database.choose"].firstMatch.waitForExistence(timeout: 5))
            XCTAssertEqual(app.buttons["database.choose"].firstMatch.value as? String, "Team Research")
            if tab == "Browse" {
                XCTAssertTrue(app.buttons["Search"].firstMatch.waitForExistence(timeout: 5))
            }
            capture(app, "04-\(tab)")
        }
        app.buttons["app.settings"].firstMatch.tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 5))
        capture(app, "05-settings")
    }
    @MainActor func testComposerRequiresExplicitDiscard() {
        let app = launch()
        app.buttons["home.newItem"].tap()
        let title = app.textFields["Work item title"]
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        title.tap(); title.typeText("Draft to keep")
        app.buttons["Cancel"].tap()
        XCTAssertTrue(app.buttons["Keep editing"].waitForExistence(timeout: 5))
        app.buttons["Keep editing"].tap()
        XCTAssertEqual(title.value as? String, "Draft to keep")
        app.buttons["Cancel"].tap()
        app.buttons["Discard draft"].tap()
        XCTAssertTrue(app.buttons["home.newItem"].waitForExistence(timeout: 5))
    }
    @MainActor func testEditingItemLocksDatabaseAcrossTabs() {
        let app = launch()
        let item = app.buttons.containing(NSPredicate(format: "label BEGINSWITH %@", "Plan the next research session")).firstMatch
        XCTAssertTrue(item.waitForExistence(timeout: 5))
        item.tap()
        XCTAssertTrue(app.buttons["Edit"].waitForExistence(timeout: 5))
        capture(app, "11-work-item")
        app.buttons["Edit"].tap()
        let title = app.textFields["Title"]
        title.tap(); title.typeText(" edited")
        XCTAssertTrue(app.buttons["keyboard.done"].waitForExistence(timeout: 5))
        app.buttons["keyboard.done"].tap()
        app.buttons["Manage"].firstMatch.tap()
        app.buttons["database.choose"].firstMatch.tap()
        let another = app.buttons.containing(NSPredicate(format: "label BEGINSWITH %@", "Team Research")).firstMatch
        XCTAssertTrue(another.waitForExistence(timeout: 5))
        XCTAssertFalse(another.isEnabled)
        app.buttons["Done"].tap()
        app.buttons["Home"].firstMatch.tap()
        app.buttons["Back"].tap()
        app.buttons["Discard changes"].tap()
        XCTAssertTrue(app.buttons["home.newItem"].waitForExistence(timeout: 5))
        app.buttons["database.choose"].firstMatch.tap()
        XCTAssertTrue(another.waitForExistence(timeout: 5))
        XCTAssertTrue(another.isEnabled)
    }

    @MainActor func testReaderHasHistoryButCannotCreate() {
        let app = launch()
        app.buttons["database.choose"].firstMatch.tap()
        app.buttons.containing(NSPredicate(format: "label BEGINSWITH %@", "Public reference library")).firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Read-only access to this database."].firstMatch.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["home.newItem"].isEnabled)
        XCTAssertFalse(app.buttons["home.saveURL"].isEnabled)
        XCTAssertTrue(app.buttons["home.captureHistory"].isEnabled)
        capture(app, "06-read-only")
    }
    @MainActor func testWorkItemSearchOpensOverHome() {
        let app = launch()
        XCTAssertFalse(app.textFields["Search items"].exists)
        app.buttons["home.search"].tap()
        let field = app.textFields["home.searchField"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Work items"].exists)
        capture(app, "12-search-overlay")
        field.tap()
        field.typeText("research")
        let result = app.buttons["home.searchResult.fixture-0"]
        XCTAssertTrue(result.waitForExistence(timeout: 8))
        result.tap()
        XCTAssertTrue(app.buttons["Edit"].waitForExistence(timeout: 5))
    }
    @MainActor func testLargeTextDarkAndOffline() {
        let app = launch(state: "offline", large: true, dark: true)
        XCTAssertTrue(app.buttons["home.captureHistory"].waitForExistence(timeout: 5))
        capture(app, "07-large-dark")
        app.swipeUp()
        XCTAssertTrue(app.buttons["Try again"].waitForExistence(timeout: 5))
        capture(app, "08-offline")
    }
    @MainActor func testSignedOutAndNoDatabase() {
        let app = launch(state: "signed-out")
        XCTAssertTrue(app.buttons["Sign in with Internet Identity"].waitForExistence(timeout: 5))
        capture(app, "09-signed-out")
        app.terminate()
        let empty = launch(state: "no-database")
        XCTAssertTrue(empty.staticTexts["No databases available"].waitForExistence(timeout: 5))
        capture(empty, "10-no-database")
    }
}
