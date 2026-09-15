import XCTest

final class VoicePreviewUITests: XCTestCase {
    @MainActor
    func testPreviewShowsCitedAnswerAndEndClearsIt() {
        let app = XCUIApplication()
        app.launchEnvironment["KINIC_SCREENSHOT_MODE"] = "voice-preview"
        app.launch()
        XCTAssertTrue(app.staticTexts["This answer is grounded in the selected Wiki."].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["/Knowledge/Overview"].exists)
        app.buttons["End conversation"].tap()
        XCTAssertTrue(app.buttons["Connect preview"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["This answer is grounded in the selected Wiki."].exists)
    }
}
