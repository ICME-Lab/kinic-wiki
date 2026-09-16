import Foundation
import ICNativeClient

struct AssistantNativeAuthorization {
    private static let maximumLifetimeNanoseconds: UInt64 = 3_600_000_000_000
    private static let expirationSafetyNanoseconds: UInt64 = 5_000_000_000
    private static let minimumUsefulLifetimeNanoseconds: UInt64 = 60_000_000_000

    func authorize(
        configuration: AppConfiguration,
        pending: [String: Any],
        identity: KinicIdentitySession,
        now: Date = Date()
    ) throws -> Any {
        guard let requestID = pending["requestId"] as? String,
              !requestID.isEmpty,
              let encodedKey = pending["publicKey"] as? String,
              let workerKey = Data(base64Encoded: encodedKey),
              workerKey.base64EncodedString() == encodedKey,
              let encodedLifetime = pending["maxTimeToLive"] as? String,
              let requestedLifetime = UInt64(encodedLifetime),
              requestedLifetime > 0,
              requestedLifetime <= Self.maximumLifetimeNanoseconds,
              pending["derivationOrigin"] as? String == configuration.derivationOrigin else {
            throw AssistantHTTPError(status: 403, code: "invalid_auth_state")
        }

        let session: ICAuthSession
        do { session = try identity.requireNativeSession() }
        catch { throw AssistantHTTPError(status: 401, code: "kinic_session_expired") }
        guard session.principal == identity.principal,
              session.canisterId == configuration.canisterId,
              session.derivationOrigin == configuration.derivationOrigin,
              let parentExpiration = session.delegation.delegations.map(\.delegation.expiration).min() else {
            throw AssistantHTTPError(status: 401, code: "kinic_session_expired")
        }

        let seconds = now.timeIntervalSince1970
        guard seconds >= 0, seconds <= Double(UInt64.max) / 1_000_000_000 else {
            throw AssistantHTTPError(status: 401, code: "kinic_session_expired")
        }
        let nowNanoseconds = UInt64(seconds * 1_000_000_000)
        guard parentExpiration > nowNanoseconds + Self.expirationSafetyNanoseconds else {
            throw AssistantHTTPError(status: 401, code: "kinic_session_expired")
        }
        let parentLifetime = parentExpiration - nowNanoseconds - Self.expirationSafetyNanoseconds
        let lifetime = min(requestedLifetime, parentLifetime)
        guard lifetime >= Self.minimumUsefulLifetimeNanoseconds else {
            throw AssistantHTTPError(status: 401, code: "kinic_session_expired")
        }

        let child: ICDelegationChain.SignedDelegation
        do {
            child = try session.childDelegation(
                for: workerKey,
                options: ICChildDelegationOptions(
                    maxTimeToLiveNanoseconds: lifetime,
                    targets: [configuration.canisterId],
                    permissions: .queries
                )
            )
        } catch let error as ICClientError {
            if case .expiredDelegation = error {
                throw AssistantHTTPError(status: 401, code: "kinic_session_expired")
            }
            throw AssistantHTTPError(status: 403, code: "invalid_delegation")
        } catch {
            throw AssistantHTTPError(status: 403, code: "invalid_delegation")
        }
        let chain = session.delegation.delegations + [child]
        return [
            "jsonrpc": "2.0",
            "id": requestID,
            "result": [
                "publicKey": session.delegation.publicKey.base64EncodedString(),
                "signerDelegation": chain.map(Self.encode),
            ],
        ]
    }

    private static func encode(_ signed: ICDelegationChain.SignedDelegation) -> [String: Any] {
        var delegation: [String: Any] = [
            "pubkey": signed.delegation.publicKey.base64EncodedString(),
            "expiration": String(signed.delegation.expiration),
        ]
        if let targets = signed.delegation.targets {
            delegation["targets"] = targets.map(ICPrincipal.text(from:))
        }
        if let permissions = signed.delegation.permissions {
            delegation["permissions"] = permissions.rawValue
        }
        return [
            "delegation": delegation,
            "signature": signed.signature.base64EncodedString(),
        ]
    }
}
