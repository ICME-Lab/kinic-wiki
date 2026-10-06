import XCTest

final class HomeNavigationUITests: XCTestCase {
    @MainActor private func launch(state: String = "ready", large: Bool = false, dark: Bool = false, draftStore: String? = nil) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["KINIC_SCREENSHOT_MODE"] = "navigation"
        app.launchEnvironment["KINIC_NAV_STATE"] = state
        app.launchEnvironment["KINIC_NAV_DRAFT_STORE"] = draftStore
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
                XCTAssertFalse(app.textFields["browse.searchField"].exists)
                capture(app, "browse-search-collapsed")
                app.buttons["Search"].firstMatch.tap()
                XCTAssertTrue(app.textFields["browse.searchField"].waitForExistence(timeout: 5))
                XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
                capture(app, "browse-search-expanded")
                app.textFields["browse.searchField"].typeText("\n")
                let keyboardHidden = XCTNSPredicateExpectation(
                    predicate: NSPredicate(format: "exists == false"), object: app.keyboards.firstMatch)
                XCTAssertEqual(XCTWaiter.wait(for: [keyboardHidden], timeout: 5), .completed)
                XCTAssertTrue(app.textFields["browse.searchField"].exists)
                app.buttons["Search"].firstMatch.tap()
                XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
                app.buttons["browse.cancelSearch"].tap()
                XCTAssertFalse(app.textFields["browse.searchField"].exists)
            } else {
                XCTAssertFalse(app.buttons["app.settings"].exists)
            }
            capture(app, "04-\(tab)")
        }
        app.buttons["Home"].firstMatch.tap()
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
    @MainActor func testWorkItemBodyCardAndNoResearchAction() {
        let app = launch()
        app.buttons.containing(NSPredicate(format: "label BEGINSWITH %@", "Plan the next research session")).firstMatch.tap()
        let body = app.otherElements["workItem.body"]
        XCTAssertTrue(body.waitForExistence(timeout: 5))
        XCTAssertTrue(body.staticTexts["Gather sources and write down the next steps."].exists)
        XCTAssertFalse(app.buttons["workItem.research"].exists)
        XCTAssertFalse(app.staticTexts["Comments"].exists)
        capture(app, "work-item-body-card")
    }

    @MainActor func testWorkItemBodyAndCommentComposerInBothAppearances() {
        for (name, dark, large) in [("light", false, false), ("dark", true, false), ("dark-large", true, true)] {
            let app = launch(large: large, dark: dark)
            app.buttons.containing(NSPredicate(format: "label BEGINSWITH %@", "Plan the next research session")).firstMatch.tap()
            XCTAssertTrue(app.staticTexts["Gather sources and write down the next steps."].waitForExistence(timeout: 5))
            XCTAssertTrue(app.navigationBars["Item"].exists)
            XCTAssertFalse(app.staticTexts["No comments yet."].exists)
            let comment = app.textFields["New comment"]
            for _ in 0..<4 where !comment.isHittable { app.swipeUp() }
            XCTAssertTrue(comment.waitForExistence(timeout: 5))
            XCTAssertGreaterThanOrEqual(comment.frame.height, 80)
            let post = app.buttons["workItem.postComment"]
            for _ in 0..<4 where !post.exists || !post.isHittable { app.swipeUp() }
            XCTAssertTrue(post.waitForExistence(timeout: 5))
            XCTAssertGreaterThanOrEqual(post.frame.width, 44)
            XCTAssertGreaterThanOrEqual(post.frame.height, 44)
            XCTAssertFalse(post.isEnabled)
            capture(app, "work-item-\(name)")
            comment.tap()
            comment.typeText("First line\nSecond line\nThird line\nFourth line")
            XCTAssertTrue(post.isEnabled)
            XCTAssertTrue((comment.value as? String ?? "").contains("Fourth line"))
            app.buttons["keyboard.done"].tap()
            capture(app, "work-item-\(name)-comment")
            app.terminate()
        }
    }

    @MainActor func testCommentAuthorCompactAndCopyMenu() {
        let app = launch(state: "comment-author", dark: true)
        app.buttons.containing(NSPredicate(format: "label BEGINSWITH %@", "Plan the next research session")).firstMatch.tap()
        let author = app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Author: eyluy-bu6z2-q5dwg-4sved-2jenz-2r54a-t65kq-y6cz3-kkdrx-ta472-gae")).firstMatch
        XCTAssertTrue(author.waitForExistence(timeout: 5))
        let posted = app.otherElements["workItem.comment.11111111-1111-4111-8111-111111111111"]
        XCTAssertTrue(posted.exists)
        XCTAssertEqual(posted.textFields.count, 0)
        XCTAssertTrue(app.staticTexts["New comment"].exists)
        for _ in 0..<4 where !author.isHittable { app.swipeUp() }
        capture(app, "comment-author-compact")
        author.press(forDuration: 1)
        XCTAssertTrue(app.buttons["Copy Principal ID"].waitForExistence(timeout: 5))
        capture(app, "comment-author-copy-menu")
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
        for tab in ["Manage", "Browse", "Ask AI"] {
            app.buttons[tab].firstMatch.tap()
            let chooser = app.buttons["database.choose"].firstMatch
            XCTAssertTrue(chooser.waitForExistence(timeout: 5))
            XCTAssertFalse(chooser.isEnabled)
        }
        app.buttons["Home"].firstMatch.tap()
        app.buttons["Back"].tap()
        app.buttons["Discard changes"].tap()
        XCTAssertTrue(app.buttons["home.newItem"].waitForExistence(timeout: 5))
        app.buttons["database.choose"].firstMatch.tap()
        let another = app.buttons.containing(NSPredicate(format: "label BEGINSWITH %@", "Team Research")).firstMatch
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


extension HomeNavigationUITests {
    @MainActor func testDraftRestoresAfterRelaunchAndExplicitDiscardRemovesIt() {
        let app = launch(draftStore: UUID().uuidString)
        app.buttons["home.newItem"].tap()
        let title = app.textFields["Work item title"]
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        title.tap()
        title.typeText("Remember this task")
        app.terminate()
        app.launch()
        XCTAssertTrue(app.buttons["home.newItem"].waitForExistence(timeout: 10))
        app.buttons["home.newItem"].tap()
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        XCTAssertEqual(title.value as? String, "Remember this task")
        app.buttons["Cancel"].tap()
        app.buttons["Discard draft"].tap()
        app.buttons["home.newItem"].tap()
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        XCTAssertNotEqual(title.value as? String, "Remember this task")
        title.tap()
        title.typeText("Title only")
        XCTAssertTrue(app.buttons["Save"].isEnabled)
        app.buttons["Save"].tap()
        XCTAssertTrue(app.buttons["home.localWork"].waitForExistence(timeout: 5))
        app.buttons["home.localWork"].tap()
        XCTAssertTrue(app.staticTexts["Title only"].waitForExistence(timeout: 5))
    }

    @MainActor func testDetailDraftRestoresAndCommentStaysAboveKeyboard() {
        let app = launch(draftStore: UUID().uuidString)
        let row = app.buttons.containing(NSPredicate(format: "label BEGINSWITH %@", "Plan the next research session")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        row.tap()
        app.buttons["Edit"].tap()
        let title = app.textFields["Title"]
        title.tap()
        title.typeText(" unsaved")
        // XCUI can return before the last keystroke reaches SwiftUI. Capture the
        // completed input rather than comparing a transient value after relaunch.
        let inputComplete = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "value CONTAINS %@", " unsaved"), object: title
        )
        XCTAssertEqual(XCTWaiter.wait(for: [inputComplete], timeout: 5), .completed)
        let editedTitle = title.value as? String
        XCTAssertNotEqual(editedTitle, "Plan the next research session")
        app.terminate()
        app.launch()
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        row.tap()
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        XCTAssertEqual(title.value as? String, editedTitle)
        app.buttons["Cancel"].tap()
        app.buttons["Discard changes"].tap()
        let comment = app.textFields["New comment"]
        for _ in 0..<4 where !comment.isHittable { app.swipeUp() }
        XCTAssertTrue(comment.waitForExistence(timeout: 5))
        comment.tap()
        comment.typeText("Keyboard visibility check")
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        XCTAssertLessThanOrEqual(comment.frame.maxY, app.keyboards.firstMatch.frame.minY + 1)
        let post = app.buttons["workItem.postComment"]
        let done = app.buttons["keyboard.done"]
        for _ in 0..<4 where !post.isHittable { app.swipeUp() }
        XCTAssertTrue(app.keyboards.firstMatch.exists)
        XCTAssertTrue(post.isHittable)
        XCTAssertTrue(done.isHittable)
        XCTAssertFalse(post.frame.intersects(done.frame))
        XCTAssertLessThanOrEqual(post.frame.maxY, app.keyboards.firstMatch.frame.minY + 1)
        capture(app, "work-item-comment-keyboard")
        app.buttons["keyboard.done"].tap()
        app.buttons["Back"].tap()
        app.buttons["Discard changes"].tap()
    }
}
