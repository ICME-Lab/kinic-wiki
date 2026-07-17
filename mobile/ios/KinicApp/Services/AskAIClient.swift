// Where: mobile/ios/KinicApp/Services/AskAIClient.swift
// What: Streaming client for the Kinic /chat endpoint.
// Why: The endpoint emits SSE-like JSON content chunks without authentication headers.

import Foundation

protocol AskAIStreaming: Sendable {
    func contentStream(message: String) async -> AsyncThrowingStream<String, Error>
}

actor AskAIClient: AskAIStreaming {
    private let endpoint: URL
    private let urlSession: URLSession

    init(endpoint: URL, urlSession: URLSession = .shared) {
        self.endpoint = endpoint
        self.urlSession = urlSession
    }

    func contentStream(message: String) async -> AsyncThrowingStream<String, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    var request = URLRequest(url: endpoint)
                    request.httpMethod = "POST"
                    request.setValue("application/json", forHTTPHeaderField: "content-type")
                    request.timeoutInterval = 60
                    request.httpBody = try JSONEncoder().encode(AskAIRequest(message: message))

                    let (bytes, response) = try await urlSession.bytes(for: request)
                    guard let httpResponse = response as? HTTPURLResponse else {
                        throw AskAIClientError.invalidResponse
                    }
                    guard (200..<300).contains(httpResponse.statusCode) else {
                        var data = Data()
                        for try await byte in bytes {
                            data.append(byte)
                        }
                        let message = String(data: data, encoding: .utf8) ?? "HTTP \(httpResponse.statusCode)"
                        throw AskAIClientError.http(status: httpResponse.statusCode, message: message)
                    }

                    var plainLines: [String] = []
                    var receivedDataEvent = false
                    for try await line in bytes.lines {
                        try Task.checkCancellation()
                        guard line.hasPrefix("data:") else {
                            if !line.isEmpty {
                                plainLines.append(line)
                            }
                            continue
                        }
                        let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
                        guard payload != "[DONE]" else { continue }
                        let chunk = try JSONDecoder().decode(AskAIChunk.self, from: Data(payload.utf8))
                        receivedDataEvent = true
                        continuation.yield(chunk.content)
                    }
                    if !receivedDataEvent, !plainLines.isEmpty {
                        continuation.yield(plainLines.joined(separator: "\n"))
                    }
                    continuation.finish()
                } catch is CancellationError {
                    continuation.finish(throwing: CancellationError())
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in
                task.cancel()
            }
        }
    }
}

private struct AskAIRequest: Encodable {
    let message: String
}

private struct AskAIChunk: Decodable {
    let content: String
}

enum AskAIClientError: Error, LocalizedError, Equatable {
    case invalidResponse
    case http(status: Int, message: String)

    var errorDescription: String? {
        switch self {
        case .invalidResponse:
            "Kinic AI returned an invalid network response."
        case let .http(status, message):
            "Kinic AI request failed (\(status)): \(message)"
        }
    }
}
