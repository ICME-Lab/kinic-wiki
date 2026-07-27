import Foundation
import Testing
@testable import Kinic

struct SourceCaptureContractTests {
    @Test
    func sharedBoundaryFixture() throws {
        let fixtureURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appending(path: "contracts/source-capture-contract.json")
        let data = try Data(contentsOf: fixtureURL)
        let fixture = try JSONDecoder().decode(Fixture.self, from: data)

        for entry in fixture.requestIds {
            #expect(SourceCaptureContract.isSafeRequestId(entry.value) == entry.valid)
        }
        for entry in fixture.requestPaths {
            #expect(SourceCaptureContract.isRequestPath(entry.value) == entry.valid)
        }
    }
}

private struct Fixture: Decodable {
    let requestIds: [Entry]
    let requestPaths: [Entry]
}

private struct Entry: Decodable {
    let value: String
    let valid: Bool
}
