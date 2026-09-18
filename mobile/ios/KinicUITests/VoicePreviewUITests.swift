import XCTest

final class VoicePreviewUITests: XCTestCase {
    @MainActor
    private func launch(_ state: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["KINIC_SCREENSHOT_MODE"] = "voice-preview"
        app.launchEnvironment["KINIC_VOICE_STATE"] = state
        app.launch()
        return app
    }
    @MainActor
    func testVoiceShowsAnswerAndSingleEndControl() {
        let app = launch("ready")
        XCTAssertTrue(app.staticTexts["This answer is grounded in the selected Wiki."].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["/Knowledge/Overview"].exists)
        XCTAssertFalse(app.buttons["Connect preview"].exists)
        XCTAssertFalse(app.buttons["Close"].exists)
        app.buttons["voice.end"].tap()
        XCTAssertTrue(app.staticTexts["Voice stopped"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["This answer is grounded in the selected Wiki."].exists)
    }
    @MainActor
    func testListeningCanMuteAndUnmute() {
        let app = launch("listening")
        XCTAssertTrue(app.buttons["Mute"].waitForExistence(timeout: 10))
        app.buttons["Mute"].tap()
        XCTAssertTrue(app.buttons["Unmute"].exists)
        XCTAssertTrue(app.staticTexts["Microphone muted"].exists)
        app.buttons["Unmute"].tap()
        XCTAssertTrue(app.staticTexts["Start speaking"].exists)
    }
    @MainActor
    func testConnectingCanEnd() {
        let app = launch("connecting")
        XCTAssertTrue(app.staticTexts["Connecting…"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["voice.end"].isEnabled)
        app.buttons["voice.end"].tap()
        XCTAssertTrue(app.staticTexts["Voice stopped"].waitForExistence(timeout: 5))
    }
    @MainActor
    func testPermissionErrorExplainsRecovery() {
        let app = launch("error")
        XCTAssertTrue(app.staticTexts["voice.error"].waitForExistence(timeout: 10))
        app.swipeUp()
        XCTAssertTrue(app.buttons["Voice Settings"].exists)
        XCTAssertTrue(app.buttons["Retry"].exists)
    }
    @MainActor
    func testCaveatsRemainVisibleWithAnswer() {
        let app = launch("caveats")
        let answer = app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "There is not enough supporting evidence.")).firstMatch
        XCTAssertTrue(answer.waitForExistence(timeout: 10))
        XCTAssertTrue(answer.label.contains("Conflicting information"))
        XCTAssertTrue(answer.label.contains("The dates differ between sources."))
        XCTAssertTrue(answer.label.contains("Unverified information"))
        XCTAssertTrue(answer.label.contains("The latest information could not be verified."))
    }
    @MainActor
    func testRespondingShowsProgress() {
        let app = launch("responding")
        XCTAssertTrue(app.staticTexts["Searching the Wiki and preparing an answer…"].waitForExistence(timeout: 10))
    }
    @MainActor
    func testVoiceSettingsUsesCompactAmountsWithLargeText() {
        let app = XCUIApplication()
        app.launchEnvironment["KINIC_SCREENSHOT_MODE"] = "voice-settings"
        app.launchEnvironment["KINIC_LARGE_TEXT"] = "1"
        app.launch()
        XCTAssertTrue(app.staticTexts["Voice Settings"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["B cycles"].exists)
        XCTAssertFalse(app.buttons["Unit"].exists)
        let dailyLimit = app.textFields["voice.dailyLimit"]
        XCTAssertTrue(dailyLimit.exists)
        XCTAssertEqual(dailyLimit.label, "Daily limit, in B cycles")
        let rate = app.descendants(matching: .any)["voice.cycles.Rate per minute"].firstMatch
        for _ in 0..<4 where !rate.isHittable { app.swipeUp() }
        XCTAssertTrue(rate.exists)
        XCTAssertEqual((rate.value as? String)?.filter(\.isNumber), "30000000000")
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "Voice settings large text"
        screenshot.lifetime = .keepAlways
        add(screenshot)
    }
}
