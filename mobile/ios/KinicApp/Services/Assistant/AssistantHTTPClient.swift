import Foundation
import Security

@MainActor
final class AssistantHTTPClient {
    let baseURL: URL
    private var token: String?
    private let keychainService: String
    init(configuration: AppConfiguration) {
        baseURL = configuration.authOrigin.appending(path: "api/assistant/native")
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
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        guard (200..<300).contains(response.statusCode) else {
            let value = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            throw AssistantHTTPError(status: response.statusCode, code: value?["error"] as? String ?? "request_failed")
        }
        guard data.count <= 1_000_000 else { throw URLError(.dataLengthExceedsMaximum) }
        return data
    }
}
