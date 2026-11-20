// Where: mobile/ios/KinicApp/Models/AppConfiguration.swift
// What: Typed runtime configuration loaded from Info.plist.
// Why: Native auth and IC calls must share exact canister, origin, and callback values.

import Foundation
import ICNativeClient

enum AppDeploymentEnvironment: String, Equatable, Sendable {
    case production
    case sandbox
}

struct VaultBundleConfiguration: Equatable, Sendable {
    let environment: String
    let canisterId: String
    let apiBaseURL: URL
    let identityProvider: URL
    let derivationOrigin: String?
    let callbackDomain: String
}

struct AppConfiguration: Equatable, Sendable {
    static let privacyPolicyURL = URL(string: "https://wiki.kinic.xyz/privacy-policy")!

    let canisterId: String
    let apiBaseURL: URL
    let identityProvider: URL
    let derivationOrigin: String
    let authOrigin: URL
    let paymentBaseURL: URL
    let callbackDomain: String
    let appGroupId: String?
    let keychainAccessGroup: String?
    let iapProductIds: [String]
    let askAIURL: URL
    let deploymentEnvironment: AppDeploymentEnvironment
    let vault: VaultBundleConfiguration?

    init(
        canisterId: String,
        apiBaseURL: URL,
        identityProvider: URL,
        derivationOrigin: String,
        authOrigin: URL,
        paymentBaseURL: URL,
        callbackDomain: String,
        appGroupId: String?,
        keychainAccessGroup: String?,
        iapProductIds: [String],
        askAIURL: URL,
        deploymentEnvironment: AppDeploymentEnvironment,
        vault: VaultBundleConfiguration? = nil
    ) {
        self.canisterId = canisterId
        self.apiBaseURL = apiBaseURL
        self.identityProvider = identityProvider
        self.derivationOrigin = derivationOrigin
        self.authOrigin = authOrigin
        self.paymentBaseURL = paymentBaseURL
        self.callbackDomain = callbackDomain
        self.appGroupId = appGroupId
        self.keychainAccessGroup = keychainAccessGroup
        self.iapProductIds = iapProductIds
        self.askAIURL = askAIURL
        self.deploymentEnvironment = deploymentEnvironment
        self.vault = vault
    }

    func makeICClientConfiguration() throws -> ICClientConfiguration {
        try ICClientConfiguration(
            canisterId: canisterId,
            apiBaseURL: apiBaseURL,
            internetIdentityURL: identityProvider,
            derivationOrigin: derivationOrigin,
            trustRoot: .mainnet,
            delegationTTLNanoseconds: 30 * 24 * 60 * 60 * 1_000_000_000,
            network: .default
        )
    }

    @MainActor
    func makeAuthenticationCallbackURL() throws -> URL {
        try ICInternetIdentityAuthenticator.callbackURL(
            callbackDomain: callbackDomain,
            callbackPath: "/ios-auth-callback"
        )
    }

    var sourceCaptureTriggerURL: URL {
        authOrigin.appending(path: "api/source-capture/trigger")
    }

    var iapActivateDatabaseURL: URL {
        paymentBaseURL.appending(path: "iap/activate-database")
    }

    var iapPurchaseIntentURL: URL {
        paymentBaseURL.appending(path: "iap/purchase-intents")
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
        paymentBaseURL: URL(string: "https://payment.kinic.xyz")!,
        callbackDomain: "wiki.kinic.xyz",
        appGroupId: nil,
        keychainAccessGroup: nil,
        iapProductIds: ["xyz.kinic.dbcredits.small"],
        askAIURL: URL(string: "https://api.kinic.io/chat")!,
        deploymentEnvironment: .production
    )

    static func liveFromBundle(_ bundle: Bundle = .main) -> AppConfiguration {
        let authOrigin = bundle.requiredURL("KINIC_AUTH_ORIGIN")
        return AppConfiguration(
            canisterId: bundle.requiredString("KINIC_CANISTER_ID"),
            apiBaseURL: bundle.requiredURL("KINIC_API_BASE_URL"),
            identityProvider: bundle.requiredURL("KINIC_IDENTITY_PROVIDER"),
            derivationOrigin: bundle.requiredString("KINIC_DERIVATION_ORIGIN"),
            authOrigin: authOrigin,
            paymentBaseURL: bundle.optionalURL("KINIC_PAYMENT_BASE_URL") ?? URL(string: "https://payment.kinic.xyz")!,
            callbackDomain: bundle.requiredString("KINIC_CALLBACK_DOMAIN"),
            appGroupId: bundle.optionalString("APP_GROUP_ID"),
            keychainAccessGroup: bundle.optionalString("KINIC_KEYCHAIN_ACCESS_GROUP"),
            iapProductIds: Self.iapProductIds(from: bundle.optionalString("KINIC_IAP_PRODUCT_IDS")),
            askAIURL: bundle.requiredURL("KINIC_ASK_AI_URL"),
            deploymentEnvironment: Self.deploymentEnvironment(
                from: bundle.requiredString("KINIC_DEPLOYMENT_ENVIRONMENT")
            ),
            vault: Self.vaultConfiguration(from: bundle)
        )
    }

    private static func vaultConfiguration(from bundle: Bundle) -> VaultBundleConfiguration? {
        guard let canisterId = bundle.optionalString("KINIC_VAULT_CANISTER_ID") else {
            return nil
        }
        let environment = bundle.optionalString("KINIC_VAULT_ENVIRONMENT") ?? "production"
        let apiBaseURL = bundle.optionalURL("KINIC_VAULT_API_BASE_URL") ?? URL(string: "https://icp0.io")!
        let identityProvider = bundle.optionalURL("KINIC_VAULT_IDENTITY_PROVIDER") ?? URL(string: "https://id.ai/authorize")!
        let derivationOrigin = bundle.optionalString("KINIC_VAULT_DERIVATION_ORIGIN")
        let callbackDomain = bundle.optionalString("KINIC_VAULT_CALLBACK_DOMAIN") ?? "vault.kinic.xyz"
        return VaultBundleConfiguration(
            environment: environment,
            canisterId: canisterId,
            apiBaseURL: apiBaseURL,
            identityProvider: identityProvider,
            derivationOrigin: derivationOrigin,
            callbackDomain: callbackDomain
        )
    }

    private static func iapProductIds(from value: String?) -> [String] {
        guard let value else {
            return []
        }
        return value
            .split(separator: ",")
            .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }

    static func deploymentEnvironment(from value: String) -> AppDeploymentEnvironment {
        guard let environment = AppDeploymentEnvironment(rawValue: value) else {
            preconditionFailure("Invalid KINIC_DEPLOYMENT_ENVIRONMENT: \(value)")
        }
        return environment
    }
}
