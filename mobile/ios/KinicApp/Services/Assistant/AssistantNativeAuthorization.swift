import AuthenticationServices
import Foundation
import UIKit

@MainActor
final class AssistantNativeAuthorization: NSObject, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows).first(where: \.isKeyWindow) ?? ASPresentationAnchor()
    }
    func cancel() { session?.cancel(); session = nil }
    static func response(from url: URL, callback: URL, state: String, requestID: String) throws -> Any {
        guard url.scheme == "https", url.host == callback.host, url.port == callback.port,
              url.path == callback.path, url.user == nil, url.password == nil, url.query == nil,
              let fragment = url.fragment else { throw AssistantHTTPError(status: 403, code: "invalid_callback") }
        var params: [String: String] = [:]
        for part in fragment.split(separator: "&", omittingEmptySubsequences: false) {
            let pair = part.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            guard pair.count == 2, let key = String(pair[0]).removingPercentEncoding,
                  let value = String(pair[1]).removingPercentEncoding, params[key] == nil else {
                throw AssistantHTTPError(status: 403, code: "invalid_callback")
            }
            params[key] = value
        }
        guard Set(params.keys) == Set(["state", "message"]), params["state"] == state,
              let message = params["message"], message.utf8.count <= 60000,
              let object = try JSONSerialization.jsonObject(with: Data(message.utf8)) as? [String: Any],
              object["jsonrpc"] as? String == "2.0", object["id"] as? String == requestID,
              object["result"] is [String: Any], object["error"] == nil else {
            throw AssistantHTTPError(status: 403, code: "invalid_callback")
        }
        return object
    }
    func authorize(configuration: AppConfiguration, pending: [String: Any]) async throws -> Any {
        guard session == nil,
              let state = pending["state"] as? String, let id = pending["requestId"] as? String,
              let key = pending["publicKey"] as? String, let ttl = pending["maxTimeToLive"] as? String,
              pending["derivationOrigin"] as? String == configuration.derivationOrigin else {
            throw AssistantHTTPError(status: 403, code: "invalid_auth_state")
        }
        let callback = try configuration.makeAuthenticationCallbackURL()
        let message: [String: Any] = ["jsonrpc": "2.0", "id": id, "method": "icrc34_delegation", "params": [
            "publicKey": key, "maxTimeToLive": ttl, "icrc95DerivationOrigin": configuration.derivationOrigin]]
        var url = URLComponents(url: configuration.identityProvider, resolvingAgainstBaseURL: false)!
        var fragment = URLComponents()
        fragment.queryItems = [URLQueryItem(name: "message", value: String(decoding: try JSONSerialization.data(withJSONObject: message), as: UTF8.self)),
            URLQueryItem(name: "callback", value: callback.absoluteString), URLQueryItem(name: "state", value: state)]
        url.percentEncodedFragment = fragment.percentEncodedQuery
        let returned: URL = try await withCheckedThrowingContinuation { continuation in
            let auth = ASWebAuthenticationSession(url: url.url!, callback: .https(host: configuration.callbackDomain, path: callback.path)) { url, error in
                if let url { continuation.resume(returning: url) }
                else { continuation.resume(throwing: error ?? URLError(.cancelled)) }
            }
            auth.presentationContextProvider = self
            session = auth
            if !auth.start() { session = nil; continuation.resume(throwing: URLError(.cannotConnectToHost)) }
        }
        defer { session = nil }
        return try Self.response(from: returned, callback: callback, state: state, requestID: id)
    }
}
