import Foundation
import ICNativeClient
import KinicVaultCore

public enum VaultEnvironment: String, Codable, Equatable, Sendable, CaseIterable {
    case production
    case staging
    case local

    public var displayName: String {
        switch self {
        case .production: "Production"
        case .staging: "Staging"
        case .local: "Local"
        }
    }
}

public enum VaultConnectionConfigurationError: Error, LocalizedError, Equatable, Sendable {
    case invalidEnvironment(String)
    case invalidCanisterId
    case sharedWithWikiOrigin
    case invalidAPIBaseURL
    case invalidIdentityProviderURL
    case invalidDerivationOrigin
    case invalidCallbackDomain

    public var errorDescription: String? {
        switch self {
        case .invalidEnvironment(let value):
            "Unsupported Vault environment: \(value)."
        case .invalidCanisterId:
            "The configured Vault canister ID is invalid."
        case .sharedWithWikiOrigin:
            "Vault must use a dedicated canister and callback origin separate from Wiki."
        case .invalidAPIBaseURL:
            "The Vault API base URL is invalid."
        case .invalidIdentityProviderURL:
            "The Vault Internet Identity URL is invalid."
        case .invalidDerivationOrigin:
            "The Vault derivation origin does not match its canister."
        case .invalidCallbackDomain:
            "The Vault callback domain is invalid."
        }
    }
}

/// Runtime Vault connection configuration supporting production, staging, and Debug local replicas.
/// Strictly enforces canister and callback origin separation from Wiki.
public struct VaultConnectionConfiguration: Equatable, Sendable {
    public static let canonicalProductionWebOrigin = URL(string: "https://vault.kinic.xyz")!
    public static let canonicalProductionCallbackDomain = "vault.kinic.xyz"
    public static let callbackPath = "/ios-vault-auth-callback"
    public static let defaultDelegationTTLNanoseconds: UInt64 = 30 * 24 * 60 * 60 * 1_000_000_000

    public let environment: VaultEnvironment
    public let client: ICClientConfiguration
    public let callbackURL: URL
    public let webOrigin: URL

    public var isLocal: Bool { environment == .local }
    public var canisterId: String { client.canisterId }

    public static func local(from data: Data) throws -> VaultConnectionConfiguration {
        let local = try VaultLocalConfiguration(data: data)
        var components = URLComponents()
        components.scheme = local.callbackURL.scheme
        components.host = local.callbackURL.host
        components.port = local.callbackURL.port
        guard let webOrigin = components.url else {
            throw VaultCryptoError.invalidContext
        }
        return VaultConnectionConfiguration(
            environment: .local,
            client: local.client,
            callbackURL: local.callbackURL,
            webOrigin: webOrigin
        )
    }

    public static func remote(
        environment: VaultEnvironment,
        canisterId: String,
        apiBaseURL: URL = URL(string: "https://icp0.io")!,
        internetIdentityURL: URL = URL(string: "https://id.ai/authorize")!,
        derivationOrigin: String? = nil,
        callbackDomain: String = canonicalProductionCallbackDomain,
        forbiddenCanisterIds: Set<String> = [],
        forbiddenCallbackDomains: Set<String> = []
    ) throws -> VaultConnectionConfiguration {
        guard environment == .production || environment == .staging else {
            throw VaultConnectionConfigurationError.invalidEnvironment(environment.rawValue)
        }

        let trimmedCanister = canisterId.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            _ = try ICPPrincipalCodec.decodeText(trimmedCanister)
        } catch {
            throw VaultConnectionConfigurationError.invalidCanisterId
        }
        if forbiddenCanisterIds.contains(trimmedCanister) {
            throw VaultConnectionConfigurationError.sharedWithWikiOrigin
        }

        let normalizedDomain = callbackDomain
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        guard isValidCallbackHostname(normalizedDomain) else {
            throw VaultConnectionConfigurationError.invalidCallbackDomain
        }
        if normalizedDomain == "wiki.kinic.xyz"
            || forbiddenCallbackDomains.map({ $0.lowercased() }).contains(normalizedDomain)
        {
            throw VaultConnectionConfigurationError.sharedWithWikiOrigin
        }

        guard isCleanHTTPS(apiBaseURL) else {
            throw VaultConnectionConfigurationError.invalidAPIBaseURL
        }
        guard isCleanHTTPS(internetIdentityURL) else {
            throw VaultConnectionConfigurationError.invalidIdentityProviderURL
        }

        let defaultDerivation = "https://\(trimmedCanister).icp0.io"
        let trimmedDerivation = derivationOrigin?.trimmingCharacters(in: .whitespacesAndNewlines)
        let effectiveDerivation = (trimmedDerivation?.isEmpty == false) ? trimmedDerivation! : defaultDerivation

        switch environment {
        case .production:
            guard apiBaseURL.host?.lowercased() == "icp0.io",
                  apiBaseURL.port == nil,
                  apiBaseURL.path.isEmpty || apiBaseURL.path == "/"
            else {
                throw VaultConnectionConfigurationError.invalidAPIBaseURL
            }
            guard internetIdentityURL.host?.lowercased() == "id.ai",
                  internetIdentityURL.port == nil,
                  internetIdentityURL.path == "/authorize"
            else {
                throw VaultConnectionConfigurationError.invalidIdentityProviderURL
            }
            guard effectiveDerivation == defaultDerivation else {
                throw VaultConnectionConfigurationError.invalidDerivationOrigin
            }
            guard normalizedDomain == canonicalProductionCallbackDomain else {
                throw VaultConnectionConfigurationError.invalidCallbackDomain
            }
        case .staging:
            guard let derivationURL = URL(string: effectiveDerivation),
                  isCleanHTTPS(derivationURL),
                  let derivationHost = derivationURL.host?.lowercased(),
                  derivationHost.hasPrefix("\(trimmedCanister).")
            else {
                throw VaultConnectionConfigurationError.invalidDerivationOrigin
            }
        case .local:
            throw VaultConnectionConfigurationError.invalidEnvironment(environment.rawValue)
        }

        var originComponents = URLComponents()
        originComponents.scheme = "https"
        originComponents.host = normalizedDomain
        guard let webOrigin = originComponents.url else {
            throw VaultConnectionConfigurationError.invalidCallbackDomain
        }
        originComponents.path = callbackPath
        guard let callbackURL = originComponents.url else {
            throw VaultConnectionConfigurationError.invalidCallbackDomain
        }

        let client = try ICClientConfiguration(
            canisterId: trimmedCanister,
            apiBaseURL: apiBaseURL,
            internetIdentityURL: internetIdentityURL,
            derivationOrigin: effectiveDerivation,
            trustRoot: .mainnet,
            delegationTTLNanoseconds: defaultDelegationTTLNanoseconds,
            network: .default
        )

        return VaultConnectionConfiguration(
            environment: environment,
            client: client,
            callbackURL: callbackURL,
            webOrigin: webOrigin
        )
    }

    private static func isCleanHTTPS(_ url: URL) -> Bool {
        guard url.scheme?.lowercased() == "https",
              let host = url.host, !host.isEmpty,
              url.user == nil,
              url.password == nil,
              url.query == nil,
              url.fragment == nil
        else {
            return false
        }
        return true
    }

    private static func isValidCallbackHostname(_ host: String) -> Bool {
        guard !host.isEmpty,
              host.count <= 255,
              host.contains("."),
              !host.contains("/"),
              !host.contains(":"),
              !host.contains("?"),
              !host.contains("#"),
              host.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "." || $0 == "-") }),
              !host.hasPrefix("."),
              !host.hasSuffix(".")
        else {
            return false
        }
        return true
    }
}
