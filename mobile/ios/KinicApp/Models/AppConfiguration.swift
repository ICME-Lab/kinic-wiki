// Where: mobile/ios/KinicApp/Models/AppConfiguration.swift
// What: Typed runtime configuration loaded from Info.plist.
// Why: Native auth and IC calls must share exact canister, origin, and callback values.

import Foundation
import ICNativeClient

struct AppConfiguration: Equatable, Sendable {
    let canisterId: String
    let apiBaseURL: URL
    let derivationOrigin: String
    let authOrigin: URL
    let callbackDomain: String
    let appGroupId: String?
    let openURL: URL

    var icClientConfiguration: ICClientConfiguration {
        ICClientConfiguration(
            canisterId: canisterId,
            apiBaseURL: apiBaseURL,
            identityProvider: URL(string: "https://id.ai/#authorize")!,
            derivationOrigin: derivationOrigin
        )
    }

    var sourceCaptureTriggerURL: URL {
        authOrigin.appending(path: "api/source-capture/trigger")
    }

    static let preview = AppConfiguration(
        canisterId: "xis3j-paaaa-aaaai-axumq-cai",
        apiBaseURL: URL(string: "https://icp0.io")!,
        derivationOrigin: "https://xis3j-paaaa-aaaai-axumq-cai.icp0.io",
        authOrigin: URL(string: "https://wiki.kinic.xyz")!,
        callbackDomain: "wiki.kinic.xyz",
        appGroupId: nil,
        openURL: URL(string: "https://wiki.kinic.xyz/ios-share")!
    )

    static func liveFromBundle(_ bundle: Bundle = .main) -> AppConfiguration {
        AppConfiguration(
            canisterId: bundle.requiredString("KINIC_CANISTER_ID"),
            apiBaseURL: bundle.requiredURL("KINIC_API_BASE_URL"),
            derivationOrigin: bundle.requiredString("KINIC_DERIVATION_ORIGIN"),
            authOrigin: bundle.requiredURL("KINIC_AUTH_ORIGIN"),
            callbackDomain: bundle.requiredString("KINIC_CALLBACK_DOMAIN"),
            appGroupId: bundle.optionalString("APP_GROUP_ID"),
            openURL: bundle.requiredURL("KINIC_OPEN_URL")
        )
    }
}
