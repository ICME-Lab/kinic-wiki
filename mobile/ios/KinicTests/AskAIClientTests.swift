// Where: mobile/ios/KinicTests/AskAIClientTests.swift
// What: Kinic chat request and SSE-like response contract tests.
// Why: Ask AI depends on an internal endpoint whose only request field and chunk framing must stay stable.

import Foundation
import Testing
@testable import Kinic

@Suite(.serialized)
struct AskAIClientTests {
    @Test
    func postsMessageAndParsesSSEChunks() async throws {
        let recorder = AskAIRequestRecorder()
        AskAIURLProtocolStub.handler = { request in
            recorder.record(request)
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["content-type": "text/event-stream"]
            )!
            let body = """
            data: {"content":"Grounded "}
            data: {"content":"answer"}
            data: [DONE]

            """
            return (response, Data(body.utf8))
        }
        defer { AskAIURLProtocolStub.handler = nil }

        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [AskAIURLProtocolStub.self]
        let client = AskAIClient(
            endpoint: URL(string: "https://api.kinic.io/chat")!,
            urlSession: URLSession(configuration: configuration)
        )

        var chunks: [String] = []
        for try await chunk in await client.contentStream(message: "Question") {
            chunks.append(chunk)
        }

        #expect(chunks == ["Grounded ", "answer"])
        let request = recorder.request
        #expect(request?.httpMethod == "POST")
        #expect(request?.value(forHTTPHeaderField: "content-type") == "application/json")
        let body = try #require(recorder.body)
        let object = try #require(JSONSerialization.jsonObject(with: body) as? [String: String])
        #expect(object == ["message": "Question"])
    }

    @Test
    func exposesHTTPFailureBody() async throws {
        AskAIURLProtocolStub.handler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 429,
                httpVersion: nil,
                headerFields: nil
            )!
            return (response, Data("rate limited".utf8))
        }
        defer { AskAIURLProtocolStub.handler = nil }

        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [AskAIURLProtocolStub.self]
        let client = AskAIClient(
            endpoint: URL(string: "https://api.kinic.io/chat")!,
            urlSession: URLSession(configuration: configuration)
        )

        do {
            for try await _ in await client.contentStream(message: "Question") { }
            Issue.record("Expected HTTP error")
        } catch {
            #expect(error as? AskAIClientError == .http(status: 429, message: "rate limited"))
        }
    }
}

private final class AskAIRequestRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var storedRequest: URLRequest?
    private var storedBody: Data?

    var request: URLRequest? {
        lock.withLock { storedRequest }
    }

    var body: Data? {
        lock.withLock { storedBody }
    }

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

    override class func canInit(with request: URLRequest) -> Bool {
        true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        do {
            guard let handler = Self.handler else {
                throw URLError(.badServerResponse)
            }
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() { }
}
