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

@MainActor
final class AssistantVoiceFinalizationTests: XCTestCase {
    private func snapshot(_ voice: String, id: String = "session") throws -> AssistantSnapshot {
        let data = try JSONSerialization.data(withJSONObject: ["revision": 1, "id": id, "databaseId": "db", "scope": "/Knowledge", "status": "ready", "generation": 1, "reconnectGraceMs": 120000, "messages": [], "utterances": [], "voice": voice])
        return try JSONDecoder().decode(AssistantSnapshot.self, from: data)
    }
    func testWaitsForOffBeforeReturningFinalState() async throws {
        var now: TimeInterval = 0
        var polls = 0
        let result = try await AssistantVoiceFinalization.waitForStop(conversationID: "session", databaseID: "db", now: { now }, pause: { now += 1 }) { remaining in
            XCTAssertEqual(remaining, 30 - now)
            polls += 1
            return try self.snapshot(polls < 3 ? "stopping" : "off")
        }
        XCTAssertEqual(polls, 3)
        XCTAssertEqual(result.voice, "off")
    }
    func testTimeoutDoesNotReturnAnUnfinishedSnapshotAndCanRetry() async throws {
        var now: TimeInterval = 0
        do {
            _ = try await AssistantVoiceFinalization.waitForStop(conversationID: "session", databaseID: "db", now: { now }, pause: { now += 1 }) { _ in try self.snapshot("stopping") }
            XCTFail("Unfinished voice must not finalize")
        } catch { XCTAssertEqual((error as? URLError)?.code, .timedOut) }
        XCTAssertEqual(now, 30)
        let result = try await AssistantVoiceFinalization.waitForStop(conversationID: "session", databaseID: "db") { _ in try self.snapshot("off") }
        XCTAssertEqual(result.voice, "off")
    }
    func testRejectsAnotherConversationAndPropagatesNetworkFailure() async throws {
        do {
            _ = try await AssistantVoiceFinalization.waitForStop(conversationID: "session", databaseID: "db") { _ in try self.snapshot("off", id: "replacement") }
            XCTFail("Must not finalize a replacement")
        } catch { XCTAssertEqual((error as? URLError)?.code, .cannotParseResponse) }
        do {
            _ = try await AssistantVoiceFinalization.waitForStop(conversationID: "session", databaseID: "db") { _ in throw URLError(.networkConnectionLost) }
            XCTFail("Must retain recovery on disconnect")
        } catch { XCTAssertEqual((error as? URLError)?.code, .networkConnectionLost) }
    }
}
