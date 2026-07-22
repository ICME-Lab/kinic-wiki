// Where: mobile/ios/KinicApp/Services/AskAIClient.swift
// What: Full-completion client for the Kinic /chat endpoint.
// Why: Model output must be completely received and validated before any text reaches the UI.

import Foundation

protocol AskAICompleting: Sendable {
    func completeContent(message: String, timeout: Duration) async throws -> String
}

actor AskAIClient: AskAICompleting {
    static let maximumResponseBytes = 128 * 1_024

    private let endpoint: URL
    private let urlSession: URLSession

    init(endpoint: URL, urlSession: URLSession = .shared) {
        self.endpoint = endpoint
        self.urlSession = urlSession
    }

    func completeContent(message: String, timeout: Duration) async throws -> String {
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.timeoutInterval = Self.timeInterval(for: timeout)
        request.httpBody = try JSONEncoder().encode(AskAIRequest(message: message))

        let (data, response) = try await perform(request: request, timeout: timeout)
        try Task.checkCancellation()
        guard let httpResponse = response as? HTTPURLResponse else {
            throw AskAIClientError.invalidResponse
        }
        guard (200..<300).contains(httpResponse.statusCode) else {
            let message = String(data: data, encoding: .utf8) ?? "HTTP \(httpResponse.statusCode)"
            throw AskAIClientError.http(status: httpResponse.statusCode, message: message)
        }
        guard let body = String(data: data, encoding: .utf8) else {
            throw AskAIClientError.invalidResponse
        }
        return try Self.parseSSE(body)
    }

    private func perform(request: URLRequest, timeout: Duration) async throws -> (Data, URLResponse) {
        try await withThrowingTaskGroup(of: (Data, URLResponse).self) { group in
            group.addTask { [urlSession] in
                let (bytes, response) = try await urlSession.bytes(for: request)
                guard response.expectedContentLength <= Int64(Self.maximumResponseBytes) else {
                    throw AskAIClientError.responseTooLarge
                }

                var data = Data()
                if response.expectedContentLength > 0 {
                    data.reserveCapacity(Int(response.expectedContentLength))
                }
                for try await byte in bytes {
                    guard data.count < Self.maximumResponseBytes else {
                        throw AskAIClientError.responseTooLarge
                    }
                    data.append(byte)
                }
                return (data, response)
            }
            group.addTask {
                try await Task.sleep(for: timeout)
                throw AskAIClientError.timeout
            }
            guard let result = try await group.next() else {
                throw AskAIClientError.invalidResponse
            }
            group.cancelAll()
            return result
        }
    }

    static func parseSSE(_ body: String) throws -> String {
        var content = ""
        var receivedEvent = false
        var reachedCompletion = false
        var receivedDone = false

        for rawLine in body.split(omittingEmptySubsequences: false, whereSeparator: \Character.isNewline) {
            let line = String(rawLine).trimmingCharacters(in: CharacterSet(charactersIn: "\r"))
            if reachedCompletion {
                let trailingLine = line.trimmingCharacters(in: CharacterSet.whitespaces)
                if trailingLine.isEmpty { continue }
                guard trailingLine == "data: [DONE]", !receivedDone else {
                    throw AskAIClientError.invalidResponse
                }
                receivedDone = true
                continue
            }
            guard !line.isEmpty else { continue }
            guard line.hasPrefix("data:") else {
                throw AskAIClientError.invalidResponse
            }
            receivedEvent = true
            let payload = line.dropFirst(5).trimmingCharacters(in: CharacterSet.whitespaces)
            if payload == "[DONE]" {
                reachedCompletion = true
                receivedDone = true
                continue
            }

            let event: AskAIEvent
            do {
                event = try JSONDecoder().decode(AskAIEvent.self, from: Data(payload.utf8))
            } catch {
                throw AskAIClientError.invalidResponse
            }
            if let chunk = event.content {
                content += chunk
                guard content.utf8.count <= maximumResponseBytes else {
                    throw AskAIClientError.responseTooLarge
                }
            }
            if let finishReason = event.finishReason {
                switch finishReason {
                case "stop":
                    reachedCompletion = true
                case "length":
                    throw AskAIClientError.truncatedResponse
                case "content_filter":
                    throw AskAIClientError.contentFiltered
                default:
                    throw AskAIClientError.invalidResponse
                }
            } else if event.content == nil {
                throw AskAIClientError.invalidResponse
            }
        }

        guard receivedEvent, !content.isEmpty else {
            throw AskAIClientError.invalidResponse
        }
        guard reachedCompletion else {
            throw AskAIClientError.incompleteStream
        }
        return content
    }

    private static func timeInterval(for duration: Duration) -> TimeInterval {
        let components = duration.components
        return max(
            0.001,
            Double(components.seconds) + Double(components.attoseconds) / 1_000_000_000_000_000_000
        )
    }
}

private struct AskAIRequest: Encodable {
    let message: String
}

private struct AskAIEvent: Decodable {
    let content: String?
    let finishReason: String?

    enum CodingKeys: String, CodingKey {
        case content
        case finishReason = "finish_reason"
    }
}

enum AskAIClientError: Error, LocalizedError, Equatable {
    case invalidResponse
    case incompleteStream
    case truncatedResponse
    case contentFiltered
    case responseTooLarge
    case timeout
    case http(status: Int, message: String)

    var errorDescription: String? {
        switch self {
        case .invalidResponse:
            "Kinic AI returned an invalid network response."
        case .incompleteStream:
            "Kinic AI stopped before the response was complete. Try again."
        case .truncatedResponse:
            "Kinic AI reached its response limit before finishing. Try a narrower question."
        case .contentFiltered:
            "Kinic AI could not return this response because it was filtered."
        case .responseTooLarge:
            "Kinic AI returned more data than Ask AI can safely process."
        case .timeout:
            "Kinic AI did not respond in time."
        case let .http(status, message):
            "Kinic AI request failed (\(status)): \(message)"
        }
    }
}
