import XCTest
@testable import Kinic

/// The watchdog exists because a half-open socket never throws; only the
/// absence of received messages over time reveals that the peer is gone.
final class AssistantLivenessTests: XCTestCase {
    func testSnapshotRevisionRejectsLateCommandState() {
        XCTAssertTrue(AssistantSnapshotOrdering.shouldApply(currentRevision: 7, incomingRevision: 8))
        XCTAssertFalse(AssistantSnapshotOrdering.shouldApply(currentRevision: 8, incomingRevision: 8))
        XCTAssertFalse(AssistantSnapshotOrdering.shouldApply(currentRevision: 8, incomingRevision: 7))
    }
    func testDoesNotReconnectBeforeAnyMessageArrives() {
        XCTAssertFalse(AssistantLiveness.shouldReconnect(lastReceivedAt: nil, now: Date()))
    }

    func testKeepsTheConnectionWhileMessagesKeepArriving() {
        let now = Date()
        XCTAssertFalse(
            AssistantLiveness.shouldReconnect(
                lastReceivedAt: now.addingTimeInterval(-1),
                now: now
            )
        )
    }

    func testDoesNotReconnectJustBelowTheTimeout() {
        let now = Date()
        XCTAssertFalse(
            AssistantLiveness.shouldReconnect(
                lastReceivedAt: now.addingTimeInterval(-Double(AssistantLiveness.timeoutSeconds) + 0.5),
                now: now
            )
        )
    }

    func testReconnectsOnceTheTimeoutElapses() {
        let now = Date()
        XCTAssertTrue(
            AssistantLiveness.shouldReconnect(
                lastReceivedAt: now.addingTimeInterval(-Double(AssistantLiveness.timeoutSeconds)),
                now: now
            )
        )
    }

    func testTimeoutToleratesAtLeastTwoMissedHeartbeats() {
        XCTAssertGreaterThanOrEqual(
            AssistantLiveness.timeoutSeconds,
            AssistantLiveness.heartbeatSeconds * 2
        )
    }

    /// A heartbeat reply is not a snapshot; decoding it as one would throw and
    /// drop the connection.
    func testRecognizesHeartbeatReplies() {
        XCTAssertTrue(
            AssistantLiveness.isHeartbeatReply([
                "type": "heartbeat",
                "requestId": UUID().uuidString.lowercased(),
            ])
        )
        XCTAssertFalse(AssistantLiveness.isHeartbeatReply(["type": "snapshot"]))
        XCTAssertFalse(AssistantLiveness.isHeartbeatReply([:]))
    }

    func testHeartbeatRequestIsWellFormedForTheWorkerContract() throws {
        let id = UUID().uuidString.lowercased()
        let decoded = try JSONSerialization.jsonObject(
            with: Data(AssistantLiveness.heartbeatRequest(id: id).utf8)
        ) as? [String: Any]
        XCTAssertEqual(decoded?["type"] as? String, "heartbeat")
        XCTAssertEqual(decoded?["requestId"] as? String, id)
    }
}
