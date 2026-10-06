import XCTest
@testable import Kinic

final class AssistantHistoryContextTests: XCTestCase {
    func testContextFitsBodyLimitWithUnicodeAndPreservesRecentOrder() throws {
        let messages = (0..<30).map { AskAIMessage(role: .user, text: "\($0)" + String(repeating: "あ🌸\"", count: 2000)) }
        let context = AssistantHistoryContext.make(messages)
        XCTAssertLessThanOrEqual(context.count, 20)
        XCTAssertLessThanOrEqual(try JSONSerialization.data(withJSONObject: context).count, 12000)
        XCTAssertTrue(context.last?["text"]?.hasPrefix("29") == true)
        XCTAssertTrue(context.allSatisfy { ($0["text"]?.utf16.count ?? 0) <= 4000 })
    }
}
