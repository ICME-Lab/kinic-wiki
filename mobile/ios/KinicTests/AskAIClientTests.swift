// Where: mobile/ios/KinicTests/AskAIClientTests.swift
// What: Full SSE completion and Kinic chat request contract tests.
// Why: Ask AI must reject incomplete or malformed model output before parsing tags.

import Foundation
import Testing
@testable import Kinic

@Suite(.serialized)
struct AskAIClientTests {
    @Test
    func postsMessageAndConcatenatesCRLFSSEContent() async throws {
        let recorder = AskAIRequestRecorder()
        AskAIURLProtocolStub.handler = { request in
            recorder.record(request)
            return (
                Self.response(for: request, status: 200),
                Data("data: {\"content\":\"Grounded \"}\r\ndata: {\"content\":\"answer\"}\r\ndata: [DONE]\r\n".utf8)
            )
        }
        defer { AskAIURLProtocolStub.handler = nil }

        let content = try await makeClient().completeContent(message: "Question", timeout: .seconds(30))

        #expect(content == "Grounded answer")
        #expect(recorder.request?.httpMethod == "POST")
        #expect(recorder.request?.timeoutInterval == 30)
        let body = try #require(recorder.body)
        let object = try #require(JSONSerialization.jsonObject(with: body) as? [String: String])
        #expect(object == ["message": "Question"])
    }

    @Test
    func acceptsFinishReasonAsTerminator() throws {
        let body = "data: {\"content\":\"final\",\"finish_reason\":\"stop\"}\ndata: [DONE]\n"
        #expect(try AskAIClient.parseSSE(body) == "final")
    }

    @Test(arguments: [
        "plain response",
        "data: not-json\n",
        "data: {\"role\":\"assistant\"}\n",
        "data: [DONE]\n",
        "data: {\"content\":\"\"}\n"
    ])
    func rejectsMalformedNonSSEAndEmptyResponses(_ body: String) {
        #expect(throws: AskAIClientError.invalidResponse) {
            try AskAIClient.parseSSE(body)
        }
    }

    @Test
    func rejectsOversizedResponse() async throws {
        AskAIURLProtocolStub.handler = { request in
            let content = String(repeating: "a", count: AskAIClient.maximumResponseBytes)
            return (Self.response(for: request, status: 200), Data("data: {\"content\":\"\(content)\"}\n".utf8))
        }
        defer { AskAIURLProtocolStub.handler = nil }

        await #expect(throws: AskAIClientError.responseTooLarge) {
            try await makeClient().completeContent(message: "Question", timeout: .seconds(1))
        }
    }

    @Test
    func rejectsDeclaredOversizedResponseWithoutWaitingForBody() async throws {
        AskAIURLProtocolStub.finishesLoading = false
        AskAIURLProtocolStub.handler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: [
                    "content-type": "text/event-stream",
                    "content-length": String(AskAIClient.maximumResponseBytes + 1),
                ]
            )!
            return (response, Data())
        }
        defer {
            AskAIURLProtocolStub.handler = nil
            AskAIURLProtocolStub.finishesLoading = true
        }

        await #expect(throws: AskAIClientError.responseTooLarge) {
            try await makeClient().completeContent(message: "Question", timeout: .seconds(1))
        }
    }

    @Test
    func exposesHTTPFailureBody() async throws {
        AskAIURLProtocolStub.handler = { request in
            (Self.response(for: request, status: 429), Data("rate limited".utf8))
        }
        defer { AskAIURLProtocolStub.handler = nil }

        await #expect(throws: AskAIClientError.http(status: 429, message: "rate limited")) {
            try await makeClient().completeContent(message: "Question", timeout: .seconds(1))
        }
    }

    @Test
    func timesOutAndSupportsCancellation() async throws {
        AskAIURLProtocolStub.finishesLoading = false
        AskAIURLProtocolStub.handler = { request in
            (Self.response(for: request, status: 200), Data())
        }
        defer {
            AskAIURLProtocolStub.handler = nil
            AskAIURLProtocolStub.finishesLoading = true
        }

        await #expect(throws: AskAIClientError.timeout) {
            try await makeClient().completeContent(message: "Question", timeout: .milliseconds(20))
        }

        let task = Task {
            try await makeClient().completeContent(message: "Question", timeout: .seconds(60))
        }
        task.cancel()
        await #expect(throws: CancellationError.self) {
            try await task.value
        }
    }

    private func makeClient() -> AskAIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [AskAIURLProtocolStub.self]
        return AskAIClient(
            endpoint: URL(string: "https://api.kinic.io/chat")!,
            urlSession: URLSession(configuration: configuration)
        )
    }

    private static func response(for request: URLRequest, status: Int) -> HTTPURLResponse {
        HTTPURLResponse(
            url: request.url!,
            statusCode: status,
            httpVersion: nil,
            headerFields: ["content-type": "text/event-stream"]
        )!
    }
}

private final class AskAIRequestRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var storedRequest: URLRequest?
    private var storedBody: Data?

    var request: URLRequest? { lock.withLock { storedRequest } }
    var body: Data? { lock.withLock { storedBody } }

    func record(_ request: URLRequest) {
        let body = request.httpBody ?? Self.readBodyStream(request.httpBodyStream)
        lock.withLock {
            storedRequest = request
            storedBody = body
        }
    }

    private static func readBodyStream(_ stream: InputStream?) -> Data? {
        guard let stream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 1_024)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            guard count > 0 else { break }
            data.append(buffer, count: count)
        }
        return data.isEmpty ? nil : data
    }
}

private final class AskAIURLProtocolStub: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?
    nonisolated(unsafe) static var finishesLoading = true

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        do {
            guard let handler = Self.handler else { throw URLError(.badServerResponse) }
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            if Self.finishesLoading { client?.urlProtocolDidFinishLoading(self) }
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() { }
}
