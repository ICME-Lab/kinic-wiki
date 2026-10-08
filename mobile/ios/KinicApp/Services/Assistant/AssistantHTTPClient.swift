import Foundation
import Security

@MainActor
protocol AssistantHTTPProviding: AnyObject {
    var hasToken: Bool { get }
    func setToken(_ token: String) throws
    func clearToken()
    func request(_ path: String, conversation: String?, method: String, body: [String: Any]?) throws -> URLRequest
    func send(_ request: URLRequest) async throws -> Data
    func data(_ path: String, conversation: String?, method: String, body: [String: Any]?) async throws -> Data
    func snapshot(conversation: String, metadata: Data?) async throws -> AssistantSnapshot
}

extension AssistantHTTPProviding {
    func request(_ path: String, conversation: String? = nil, method: String = "GET", body: [String: Any]? = nil) throws -> URLRequest {
        try request(path, conversation: conversation, method: method, body: body)
    }
    func data(_ path: String, conversation: String? = nil, method: String = "GET", body: [String: Any]? = nil) async throws -> Data {
        try await data(path, conversation: conversation, method: method, body: body)
    }
    func snapshot(conversation: String) async throws -> AssistantSnapshot {
        try await snapshot(conversation: conversation, metadata: nil)
    }
}

@MainActor
final class AssistantHTTPClient: AssistantHTTPProviding {
    let baseURL: URL
    private var token: String?
    private var cachedHistory: AssistantSnapshot?
    private var credentialGeneration = 0
    private let urlSession: URLSession
    var hasToken: Bool { token != nil }
    private let keychainService: String
    init(configuration: AppConfiguration, urlSession: URLSession = .shared) {
        self.urlSession = urlSession
        baseURL = configuration.authOrigin.appending(path: "api/assistant/native")
        // Keep the existing Keychain service so sign-out also removes tokens from older builds.
        keychainService = "xyz.kinic.voice-preview.\(configuration.canisterId)"
        var value: CFTypeRef?
        if SecItemCopyMatching([kSecClass: kSecClassGenericPassword, kSecAttrService: keychainService,
            kSecAttrAccount: "bearer", kSecReturnData: true, kSecMatchLimit: kSecMatchLimitOne] as CFDictionary, &value) == errSecSuccess,
           let data = value as? Data { token = String(data: data, encoding: .utf8) }
    }
    func setToken(_ token: String) throws {
        clearToken()
        let status = SecItemAdd([
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: keychainService,
            kSecAttrAccount: "bearer",
            kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            kSecAttrSynchronizable: false,
            kSecValueData: Data(token.utf8)
        ] as CFDictionary, nil)
        guard status == errSecSuccess else { throw AssistantHTTPError(status: 500, code: "keychain_failed") }
        self.token = token
    }
    func clearToken() {
        token = nil
        credentialGeneration += 1
        cachedHistory = nil
        SecItemDelete([kSecClass: kSecClassGenericPassword, kSecAttrService: keychainService, kSecAttrAccount: "bearer"] as CFDictionary)
    }
    func request(_ path: String, conversation: String? = nil, method: String = "GET", body: [String: Any]? = nil) throws -> URLRequest {
        var components = URLComponents(url: baseURL.appending(path: path), resolvingAgainstBaseURL: false)!
        if let conversation { components.queryItems = [URLQueryItem(name: "conversationId", value: conversation)] }
        var request = URLRequest(url: components.url!, timeoutInterval: 20)
        request.httpMethod = method
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        return request
    }
    func data(_ path: String, conversation: String? = nil, method: String = "GET", body: [String: Any]? = nil) async throws -> Data {
        try await send(request(path, conversation: conversation, method: method, body: body))
    }
    func send(_ request: URLRequest) async throws -> Data {
        let (data, response) = try await urlSession.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        guard (200..<300).contains(response.statusCode) else {
            let value = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            throw AssistantHTTPError(status: response.statusCode, code: value?["error"] as? String ?? "request_failed")
        }
        guard data.count <= 1_000_000 else { throw URLError(.dataLengthExceedsMaximum) }
        return data
    }
    func snapshot(conversation: String, metadata initialMetadata: Data? = nil) async throws -> AssistantSnapshot {
        struct EmbeddedHistory: Decodable { let historyPage: AssistantHistoryPage? }
        let generation = credentialGeneration
        var initial = initialMetadata
        for _ in 0..<3 {
            let metadata: Data
            if let initial { metadata = initial }
            else {
                var request = try request("conversation", conversation: conversation)
                var components = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!
                var query = components.queryItems ?? []
                query.append(URLQueryItem(name: "includeHistory", value: "1"))
                if let cachedHistory, cachedHistory.id == conversation {
                    query.append(URLQueryItem(name: "knownRevision", value: String(cachedHistory.revision)))
                }
                components.queryItems = query
                request.url = components.url
                do { metadata = try await send(request) }
                catch let error as AssistantHTTPError where error.status == 409 && error.code == "stale_state" {
                    continue
                }
            }
            initial = nil
            guard generation == credentialGeneration else { throw CancellationError() }
            let state = try JSONDecoder().decode(AssistantSnapshot.self, from: metadata)
            guard state.id == conversation else { throw URLError(.cannotParseResponse) }
            // Metadata is still authenticated and authorized on every read.
            // A stable revision means its already fetched history is unchanged.
            if let cachedHistory, cachedHistory.id == state.id,
               cachedHistory.databaseId == state.databaseId,
               cachedHistory.revision == state.revision {
                return state.withHistory(messages: cachedHistory.messages, utterances: cachedHistory.utterances)
            }
            var messages: [AssistantMessage] = []
            var utterances: [AssistantUtterance] = []
            var cursor: String? = "0"
            do {
                // New servers can return the first bounded page with metadata.
                // Older servers and WebSocket metadata retain paged HTTP reads.
                if let page = try JSONDecoder().decode(EmbeddedHistory.self, from: metadata).historyPage {
                    guard page.revision == state.revision else { throw AssistantHTTPError(status: 409, code: "stale_state") }
                    messages = page.messages
                    utterances = page.utterances
                    cursor = page.nextCursor
                }
                while let currentCursor = cursor {
                    var request = try request("history", conversation: conversation)
                    var components = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!
                    var query = components.queryItems ?? []
                    query.append(URLQueryItem(name: "revision", value: String(state.revision)))
                    query.append(URLQueryItem(name: "cursor", value: currentCursor))
                    components.queryItems = query
                    request.url = components.url
                    let pageData = try await send(request)
                    guard generation == credentialGeneration else { throw CancellationError() }
                    let page = try JSONDecoder().decode(AssistantHistoryPage.self, from: pageData)
                    guard page.revision == state.revision else { throw AssistantHTTPError(status: 409, code: "stale_state") }
                    messages.append(contentsOf: page.messages)
                    utterances.append(contentsOf: page.utterances)
                    cursor = page.nextCursor
                }
                let result = state.withHistory(messages: messages, utterances: utterances)
                if cachedHistory?.id != result.id || (cachedHistory?.revision ?? -1) <= result.revision {
                    cachedHistory = result
                }
                return result
            } catch let error as AssistantHTTPError where error.status == 409 && error.code == "stale_state" {
                continue
            }
        }
        throw AssistantHTTPError(status: 409, code: "stale_state")
    }
}
