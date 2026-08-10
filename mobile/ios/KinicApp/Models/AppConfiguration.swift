// Where: mobile/ios/KinicApp/Models/AppConfiguration.swift
// What: Typed runtime configuration loaded from Info.plist.
// Why: Native auth and IC calls must share exact canister, origin, and callback values.

import Foundation
import ICNativeClient

struct AppConfiguration: Equatable, Sendable {
    static let privacyPolicyURL = URL(string: "https://wiki.kinic.xyz/privacy-policy")!
    static let nativeAuthCallbackPath = "/native-auth-callback"

    let canisterId: String
    let apiBaseURL: URL
    let identityProvider: URL
    let derivationOrigin: String
    let authOrigin: URL
    let callbackDomain: String
    let appGroupId: String?
    let keychainAccessGroup: String?
    let askAIURL: URL

    var icClientConfiguration: ICClientConfiguration {
        ICClientConfiguration(
            canisterId: canisterId,
            apiBaseURL: apiBaseURL,
            identityProvider: identityProvider,
            derivationOrigin: derivationOrigin
        )
    }

    var sourceCaptureTriggerURL: URL {
        authOrigin.appending(path: "api/source-capture/trigger")
    }

    func databaseFundingURL(databaseId: String) -> URL {
        let cyclesURL = authOrigin.appending(path: "cycles")
        guard var components = URLComponents(url: cyclesURL, resolvingAgainstBaseURL: false) else {
            preconditionFailure("KINIC_AUTH_ORIGIN must be a valid absolute URL")
        }
        components.queryItems = [
            URLQueryItem(name: "database_id", value: databaseId),
            URLQueryItem(name: "status", value: DatabaseStatus.pending.rawValue)
        ]
        guard let url = components.url else {
            preconditionFailure("Database funding URL must be representable")
        }
        return url
    }

    func databaseNodeURL(databaseId: String, path: String) -> URL {
        let pathSegments = path.split(separator: "/").map(String.init)
        return (["db", databaseId] + pathSegments).reduce(authOrigin) { url, segment in
            url.appending(path: segment)
        }
    }

    func publicNodeURL(publicId: String) -> URL? {
        guard publicId.count == 32,
              publicId.allSatisfy({ $0.isHexDigit && !$0.isUppercase }) else {
            return nil
        }
        return authOrigin.appending(path: "p").appending(path: publicId)
    }

    static let preview = AppConfiguration(
        canisterId: "6emaw-iyaaa-aaaay-aacka-cai",
        apiBaseURL: URL(string: "https://icp0.io")!,
        identityProvider: URL(string: "https://id.ai/authorize")!,
        derivationOrigin: "https://6emaw-iyaaa-aaaay-aacka-cai.icp0.io",
        authOrigin: URL(string: "https://wiki.kinic.xyz")!,
        callbackDomain: "wiki.kinic.xyz",
        appGroupId: nil,
        keychainAccessGroup: nil,
        askAIURL: URL(string: "https://api.kinic.io/chat")!
    )

    static func liveFromBundle(_ bundle: Bundle = .main) -> AppConfiguration {
        AppConfiguration(
            canisterId: bundle.requiredString("KINIC_CANISTER_ID"),
            apiBaseURL: bundle.requiredURL("KINIC_API_BASE_URL"),
            identityProvider: bundle.requiredURL("KINIC_IDENTITY_PROVIDER"),
            derivationOrigin: bundle.requiredString("KINIC_DERIVATION_ORIGIN"),
            authOrigin: bundle.requiredURL("KINIC_AUTH_ORIGIN"),
            callbackDomain: bundle.requiredString("KINIC_CALLBACK_DOMAIN"),
            appGroupId: bundle.optionalString("APP_GROUP_ID"),
            keychainAccessGroup: bundle.optionalString("KINIC_KEYCHAIN_ACCESS_GROUP"),
            askAIURL: bundle.requiredURL("KINIC_ASK_AI_URL")
        )
    }
}
