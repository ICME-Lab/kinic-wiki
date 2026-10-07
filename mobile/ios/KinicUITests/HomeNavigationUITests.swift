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
    @MainActor func testCaptureSharedItemsAndWidgetDemo() throws {
        guard ProcessInfo.processInfo.environment["KINIC_DEMO_CAPTURE"] == "1" else { throw XCTSkip("Opt-in product demo capture") }
        let app = launch(state: "demo", dark: true)
        XCTAssertTrue(app.staticTexts["Plan the next research session"].waitForExistence(timeout: 10))
        print("DEMO_SCENE:home")
        capture(app, "demo-home")
        Thread.sleep(forTimeInterval: 2)
        if ProcessInfo.processInfo.environment["KINIC_DEMO_WIDGET_ONLY"] != "1" {
        print("DEMO_SCENE:create")
        app.buttons["home.newItem"].tap()
        let title = app.textFields["Work item title"]
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        title.tap(); title.typeText("Ship the next idea")
        let body = app.textViews["Work item body"]
        body.tap(); body.typeText("Review the sources and sketch a first prototype.")
        if app.buttons["Done"].isHittable { app.buttons["Done"].tap() }
        capture(app, "demo-create")
        app.buttons["Save"].firstMatch.tap()
        let row = app.buttons.containing(NSPredicate(format: "label BEGINSWITH %@", "Ship the next idea")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 12))
        Thread.sleep(forTimeInterval: 2)
        print("DEMO_SCENE:comment")
        row.tap()
        let comment = app.textFields["New comment"]
        XCTAssertTrue(comment.waitForExistence(timeout: 5))
        comment.tap(); comment.typeText("Notes reviewed. Ready to build.")
        app.buttons["keyboard.done"].tap()
        app.buttons["workItem.postComment"].tap()
        XCTAssertTrue(app.staticTexts["Notes reviewed. Ready to build."].waitForExistence(timeout: 10))
        capture(app, "demo-comment")
        Thread.sleep(forTimeInterval: 2)
        print("DEMO_SCENE:close")
        app.buttons["Close"].tap()
        XCTAssertTrue(app.buttons["Reopen"].waitForExistence(timeout: 10))
        capture(app, "demo-closed")
        Thread.sleep(forTimeInterval: 2)
        app.navigationBars.buttons.firstMatch.tap()
        app.buttons["Closed"].tap()
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        capture(app, "demo-closed-list")
        Thread.sleep(forTimeInterval: 2)
        }
        print("DEMO_SCENE:widget-setup")
        XCUIDevice.shared.press(.home)
        XCUIDevice.shared.press(.home)
        let board = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let icon = board.icons["KinicWiki"]
        XCTAssertTrue(icon.waitForExistence(timeout: 10))
        for _ in 0..<3 where !icon.isHittable { board.swipeLeft() }
        icon.press(forDuration: 1.2)
        let edit = board.buttons.matching(NSPredicate(format: "label IN %@", ["Edit Home Screen", "ホーム画面を編集"])).firstMatch
        if edit.waitForExistence(timeout: 4) { edit.tap() }
        let editMenu = board.buttons.matching(NSPredicate(format: "label IN %@", ["Edit", "編集"])).firstMatch
        if editMenu.waitForExistence(timeout: 3) { editMenu.tap() }
        let add = board.buttons.matching(NSPredicate(format: "label IN %@", ["Add Widget", "Add Widgets", "ウィジェットを追加", "追加"])).firstMatch
        if add.waitForExistence(timeout: 3) { add.tap() }
        else if board.buttons["Add"].exists { board.buttons["Add"].tap() }
        print("DEMO_WIDGET_TREE:" + board.debugDescription)
        let search = board.searchFields.firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.tap(); search.typeText("Kinic")
        let result = board.cells.matching(NSPredicate(format: "label CONTAINS[c] %@", "KinicWiki")).firstMatch
        XCTAssertTrue(result.waitForExistence(timeout: 5)); result.tap()
        let addWidget = board.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@ OR label CONTAINS %@", "Add Widget", "ウィジェットを追加")).firstMatch
        XCTAssertTrue(addWidget.waitForExistence(timeout: 5)); addWidget.tap()
        let done = board.buttons.matching(NSPredicate(format: "label IN %@", ["Done", "完了"])).firstMatch
        if done.waitForExistence(timeout: 5) { done.tap() }
        Thread.sleep(forTimeInterval: 5)
        print("DEMO_SCENE:widget")
        capture(board, "demo-widget")
        print("DEMO_WIDGET_FINAL:" + board.debugDescription)
        Thread.sleep(forTimeInterval: 5)
        print("DEMO_SCENE:end")
    }

    @MainActor func testFinishWidgetDemoCapture() throws {
        guard ProcessInfo.processInfo.environment["KINIC_DEMO_CAPTURE"] == "1" else { throw XCTSkip("Opt-in product demo capture") }
        let board = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let add = board.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@ OR label CONTAINS %@", "Add Widget", "ウィジェットを追加")).firstMatch
        XCTAssertTrue(add.waitForExistence(timeout: 10)); add.tap()
        let done = board.buttons.matching(NSPredicate(format: "label IN %@", ["Done", "完了"])).firstMatch
        if done.waitForExistence(timeout: 5) { done.tap() }
        Thread.sleep(forTimeInterval: 12)
        capture(board, "demo-widget")
        print("DEMO_WIDGET_FINAL:" + board.debugDescription)
    }

    @MainActor func testCaptureWidgetEntryDemo() throws {
        guard ProcessInfo.processInfo.environment["KINIC_DEMO_CAPTURE"] == "1" else { throw XCTSkip("Opt-in product demo capture") }
        try testCaptureSharedItemsAndWidgetDemo()
        let board = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        print("DEMO_SCENE:widget-entry")
        capture(board, "demo-widget-entry-before")
        print("DEMO_ENTRY_TREE:" + board.debugDescription)
        let item = board.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "Plan the next research session")).firstMatch
        XCTAssertTrue(item.waitForExistence(timeout: 15))
        Thread.sleep(forTimeInterval: 2)
        print("DEMO_SCENE:widget-tap")
        item.tap()
        let app = XCUIApplication()
        XCTAssertTrue(app.buttons["Close"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["Plan the next research session"].exists)
        capture(app, "demo-widget-entry-after")
        print("DEMO_SCENE:widget-opened")
        Thread.sleep(forTimeInterval: 4)
    }

    @MainActor func testCaptureFinalComposerCards() throws {
        guard ProcessInfo.processInfo.environment["KINIC_DEMO_CAPTURE"] == "1" else { throw XCTSkip("Opt-in product demo capture") }
        let app = launch(state: "demo-final", dark: true)
        app.buttons["home.newItem"].tap()
        let title = app.textFields["Work item title"]
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        app.swipeUp()
        capture(app, "final-compose-clean-empty")
        title.tap(); title.typeText("Write launch notes")
        let body = app.textViews["Work item body"]
        body.tap(); body.typeText("Ship shared work, one step at a time.")
        app.swipeUp()
        capture(app, "final-compose-clean-filled")
    }

    @MainActor func testCaptureSingleItemStoryDemo() throws {
        guard ProcessInfo.processInfo.environment["KINIC_DEMO_CAPTURE"] == "1" else { throw XCTSkip("Opt-in product demo capture") }
        let app = launch(state: "demo-story", dark: true)
        XCTAssertTrue(app.staticTexts["Plan the next release"].waitForExistence(timeout: 10))
        capture(app, "story-home")
        app.buttons["home.newItem"].tap()
        let title = app.textFields["Work item title"]
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        capture(app, "story-create-empty")
        title.tap(); title.typeText("Write launch notes")
        let body = app.textViews["Work item body"]
        body.tap(); body.typeText("Ship shared work, one step at a time.")
        capture(app, "story-create-filled")
        app.buttons["Save"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Write launch notes"].waitForExistence(timeout: 10))
        capture(app, "story-created")
        app.buttons.containing(NSPredicate(format: "label BEGINSWITH %@", "Write launch notes")).firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Can you review these launch notes?"].waitForExistence(timeout: 10))
        capture(app, "story-discussion-before")
        let comment = app.textFields["New comment"]
        XCTAssertTrue(comment.waitForExistence(timeout: 5))
        if !comment.isHittable { app.swipeUp() }
        comment.tap(); comment.typeText("Reviewed. Ready to ship.")
        app.buttons["keyboard.done"].tap()
        capture(app, "story-reply-filled")
        app.buttons["workItem.postComment"].tap()
        XCTAssertTrue(app.staticTexts["Reviewed. Ready to ship."].waitForExistence(timeout: 10))
        capture(app, "story-discussion-after")
        XCUIDevice.shared.press(.home); XCUIDevice.shared.press(.home)
        let board = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let icon = board.icons["KinicWiki"]
        // A fresh task Simulator installs this app on the second Home page.
        // Querying isHittable for an off-page SpringBoard icon throws on iOS 27.
        board.swipeLeft()
        XCTAssertTrue(icon.waitForExistence(timeout: 5))
        icon.press(forDuration: 1.2)
        let edit = board.buttons.matching(NSPredicate(format: "label IN %@", ["Edit Home Screen", "ホーム画面を編集"])).firstMatch
        if edit.waitForExistence(timeout: 4) { edit.tap() }
        let menu = board.buttons.matching(NSPredicate(format: "label IN %@", ["Edit", "編集"])).firstMatch
        if menu.waitForExistence(timeout: 3) { menu.tap() }
        let add = board.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@ OR label CONTAINS %@", "Add Widget", "ウィジェットを追加")).firstMatch
        if add.waitForExistence(timeout: 3) { add.tap() }
        let search = board.searchFields.firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 5)); search.tap(); search.typeText("Kinic")
        let result = board.cells.matching(NSPredicate(format: "label CONTAINS[c] %@", "KinicWiki")).firstMatch
        XCTAssertTrue(result.waitForExistence(timeout: 5)); result.tap()
        let addWidget = board.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@ OR label CONTAINS %@", "Add Widget", "ウィジェットを追加")).firstMatch
        XCTAssertTrue(addWidget.waitForExistence(timeout: 5)); addWidget.tap()
        let done = board.buttons.matching(NSPredicate(format: "label IN %@", ["Done", "完了"])).firstMatch
        if done.waitForExistence(timeout: 5) { done.tap() }
        let item = board.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "Write launch notes")).firstMatch
        XCTAssertTrue(item.waitForExistence(timeout: 15))
        capture(board, "story-widget")
        item.tap()
        XCTAssertTrue(app.staticTexts["Ship shared work, one step at a time."].waitForExistence(timeout: 10))
        XCTAssertEqual(app.state, .runningForeground)
        XCTAssertTrue(app.staticTexts["Reviewed. Ready to ship."].exists)
        XCTAssertTrue(app.staticTexts["Can you review these launch notes?"].exists)
        capture(app, "story-widget-opened")
    }

    @MainActor func testCaptureFinalSharedDemo() throws {
        guard ProcessInfo.processInfo.environment["KINIC_DEMO_CAPTURE"] == "1" else { throw XCTSkip("Opt-in product demo capture") }
        let app = launch(state: "demo-final", dark: true)
        XCTAssertTrue(app.staticTexts["Review launch copy"].waitForExistence(timeout: 10))
        capture(app, "final-home")
        app.buttons["home.newItem"].tap()
        let title = app.textFields["Work item title"]
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        capture(app, "final-create-empty")
        title.tap(); title.typeText("Write launch notes")
        let body = app.textViews["Work item body"]
        body.tap(); body.typeText("Ship shared work, one step at a time.")
        capture(app, "final-create-filled")
        app.buttons["Save"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Write launch notes"].waitForExistence(timeout: 10))
        capture(app, "final-created")
        app.buttons.containing(NSPredicate(format: "label BEGINSWITH %@", "Review launch copy")).firstMatch.tap()
        XCTAssertTrue(app.staticTexts["The draft is ready. Can you review it?"].waitForExistence(timeout: 10))
        capture(app, "final-discussion-before")
        let comment = app.textFields["New comment"]
        XCTAssertTrue(comment.waitForExistence(timeout: 5))
        if !comment.isHittable { app.swipeUp() }
        comment.tap(); comment.typeText("Reviewed. Ready to ship.")
        app.buttons["keyboard.done"].tap()
        capture(app, "final-reply-filled")
        app.buttons["workItem.postComment"].tap()
        XCTAssertTrue(app.staticTexts["Reviewed. Ready to ship."].waitForExistence(timeout: 10))
        capture(app, "final-discussion-after")
        app.buttons["Close"].tap()
        XCTAssertTrue(app.buttons["Reopen"].waitForExistence(timeout: 10))
        capture(app, "final-closed-detail")
        app.navigationBars.buttons.firstMatch.tap()
        app.buttons["Closed"].tap()
        XCTAssertTrue(app.staticTexts["Review launch copy"].waitForExistence(timeout: 5))
        capture(app, "final-closed-list")
        app.buttons["Open"].tap()
        app.buttons.containing(NSPredicate(format: "label BEGINSWITH %@", "Write launch notes")).firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Ship shared work, one step at a time."].waitForExistence(timeout: 5))
        capture(app, "final-next-item")
        XCUIDevice.shared.press(.home); XCUIDevice.shared.press(.home)
        let board = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let icon = board.icons["KinicWiki"]
        // A fresh task Simulator installs this app on the second Home page.
        // Querying isHittable for an off-page SpringBoard icon throws on iOS 27.
        board.swipeLeft()
        XCTAssertTrue(icon.waitForExistence(timeout: 5))
        icon.press(forDuration: 1.2)
        let edit = board.buttons.matching(NSPredicate(format: "label IN %@", ["Edit Home Screen", "ホーム画面を編集"])).firstMatch
        if edit.waitForExistence(timeout: 4) { edit.tap() }
        let menu = board.buttons.matching(NSPredicate(format: "label IN %@", ["Edit", "編集"])).firstMatch
        if menu.waitForExistence(timeout: 3) { menu.tap() }
        let add = board.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@ OR label CONTAINS %@", "Add Widget", "ウィジェットを追加")).firstMatch
        if add.waitForExistence(timeout: 3) { add.tap() }
        let search = board.searchFields.firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 5)); search.tap(); search.typeText("Kinic")
        let result = board.cells.matching(NSPredicate(format: "label CONTAINS[c] %@", "KinicWiki")).firstMatch
        XCTAssertTrue(result.waitForExistence(timeout: 5)); result.tap()
        let addWidget = board.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@ OR label CONTAINS %@", "Add Widget", "ウィジェットを追加")).firstMatch
        XCTAssertTrue(addWidget.waitForExistence(timeout: 5)); addWidget.tap()
        let done = board.buttons.matching(NSPredicate(format: "label IN %@", ["Done", "完了"])).firstMatch
        if done.waitForExistence(timeout: 5) { done.tap() }
        let item = board.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "Write launch notes")).firstMatch
        XCTAssertTrue(item.waitForExistence(timeout: 15))
        capture(board, "final-widget")
        item.tap()
        XCTAssertTrue(app.staticTexts["Ship shared work, one step at a time."].waitForExistence(timeout: 10))
        XCTAssertEqual(app.state, .runningForeground)
        capture(app, "final-widget-opened")
    }

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
