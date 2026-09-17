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
        XCTAssertTrue(app.staticTexts["音声は停止しています"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["This answer is grounded in the selected Wiki."].exists)
    }
    @MainActor
    func testListeningCanMuteAndUnmute() {
        let app = launch("listening")
        XCTAssertTrue(app.buttons["ミュート"].waitForExistence(timeout: 10))
        app.buttons["ミュート"].tap()
        XCTAssertTrue(app.buttons["ミュート解除"].exists)
        XCTAssertTrue(app.staticTexts["マイクはミュート中です"].exists)
        app.buttons["ミュート解除"].tap()
        XCTAssertTrue(app.staticTexts["話しかけてください"].exists)
    }
    @MainActor
    func testConnectingCanEnd() {
        let app = launch("connecting")
        XCTAssertTrue(app.staticTexts["接続しています…"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["voice.end"].isEnabled)
        app.buttons["voice.end"].tap()
        XCTAssertTrue(app.staticTexts["音声は停止しています"].waitForExistence(timeout: 5))
    }
    @MainActor
    func testPermissionErrorExplainsRecovery() {
        let app = launch("error")
        XCTAssertTrue(app.staticTexts["voice.error"].waitForExistence(timeout: 10))
        app.swipeUp()
        XCTAssertTrue(app.buttons["音声設定"].exists)
        XCTAssertTrue(app.buttons["再試行"].exists)
    }
    @MainActor
    func testCaveatsRemainVisibleWithAnswer() {
        let app = launch("caveats")
        let answer = app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "根拠が不足しています。")).firstMatch
        XCTAssertTrue(answer.waitForExistence(timeout: 10))
        XCTAssertTrue(answer.label.contains("矛盾する情報"))
        XCTAssertTrue(answer.label.contains("資料によって日付が異なります。"))
        XCTAssertTrue(answer.label.contains("未検証の情報"))
        XCTAssertTrue(answer.label.contains("最新情報を確認できません。"))
    }
    @MainActor
    func testRespondingShowsProgress() {
        let app = launch("responding")
        XCTAssertTrue(app.staticTexts["Wikiを調べて回答しています…"].waitForExistence(timeout: 10))
    }
    @MainActor
    func testVoiceSettingsUsesCompactAmountsWithLargeText() {
        let app = XCUIApplication()
        app.launchEnvironment["KINIC_SCREENSHOT_MODE"] = "voice-settings"
        app.launchEnvironment["KINIC_LARGE_TEXT"] = "1"
        app.launch()
        XCTAssertTrue(app.staticTexts["音声設定"].waitForExistence(timeout: 10))
        let rate = app.descendants(matching: .any)["voice.cycles.料金／分"].firstMatch
        for _ in 0..<4 where !rate.isHittable { app.swipeUp() }
        XCTAssertTrue(rate.exists)
        XCTAssertEqual((rate.value as? String)?.filter(\.isNumber), "30000000000")
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "Voice settings large text"
        screenshot.lifetime = .keepAlways
        add(screenshot)
    }
}
