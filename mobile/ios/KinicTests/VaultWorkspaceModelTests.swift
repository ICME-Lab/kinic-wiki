// Where: mobile/ios/KinicTests/VaultWorkspaceModelTests.swift
// What: Unit tests for VaultWorkspaceModel connection isolation, filtering, CRUD, and locking.
// Why: Verifies the iOS Vault tab obeys Wiki/Vault origin separation and preserves credential fields.

import Foundation
import KinicVaultCore
import KinicVaultNative
import Testing
@testable import Kinic

struct VaultWorkspaceModelTests {
    @MainActor
    @Test func resolvesRemoteProductionAndRejectsWikiOriginOverlap() throws {
        let vaultCanister = "mcx4q-2qaaa-aaaao-qqn3a-cai"
        let validConfig = AppConfiguration(
            canisterId: AppConfiguration.preview.canisterId,
            apiBaseURL: AppConfiguration.preview.apiBaseURL,
            identityProvider: AppConfiguration.preview.identityProvider,
            derivationOrigin: AppConfiguration.preview.derivationOrigin,
            authOrigin: AppConfiguration.preview.authOrigin,
            paymentBaseURL: AppConfiguration.preview.paymentBaseURL,
            callbackDomain: AppConfiguration.preview.callbackDomain,
            appGroupId: nil,
            keychainAccessGroup: nil,
            iapProductIds: [],
            askAIURL: AppConfiguration.preview.askAIURL,
            deploymentEnvironment: .production,
            vault: VaultBundleConfiguration(
                environment: "production",
                canisterId: vaultCanister,
                apiBaseURL: URL(string: "https://icp0.io")!,
                identityProvider: URL(string: "https://id.ai/authorize")!,
                derivationOrigin: "https://\(vaultCanister).icp0.io",
                callbackDomain: "vault.kinic.xyz"
            )
        )
        let resolved = try VaultWorkspaceModel.resolveConnection(from: validConfig).get()
        #expect(resolved?.environment == .production)
        #expect(resolved?.canisterId == vaultCanister)
        #expect(resolved?.client.derivationOrigin == "https://mcx4q-2qaaa-aaaao-qqn3a-cai.icp0.io")
        #expect(resolved?.callbackURL.absoluteString == "https://vault.kinic.xyz/ios-vault-auth-callback")

        // Must reject reusing Wiki's canister ID.
        let overlappingCanister = AppConfiguration(
            canisterId: AppConfiguration.preview.canisterId,
            apiBaseURL: AppConfiguration.preview.apiBaseURL,
            identityProvider: AppConfiguration.preview.identityProvider,
            derivationOrigin: AppConfiguration.preview.derivationOrigin,
            authOrigin: AppConfiguration.preview.authOrigin,
            paymentBaseURL: AppConfiguration.preview.paymentBaseURL,
            callbackDomain: AppConfiguration.preview.callbackDomain,
            appGroupId: nil,
            keychainAccessGroup: nil,
            iapProductIds: [],
            askAIURL: AppConfiguration.preview.askAIURL,
            deploymentEnvironment: .production,
            vault: VaultBundleConfiguration(
                environment: "production",
                canisterId: AppConfiguration.preview.canisterId,
                apiBaseURL: URL(string: "https://icp0.io")!,
                identityProvider: URL(string: "https://id.ai/authorize")!,
                derivationOrigin: nil,
                callbackDomain: "vault.kinic.xyz"
            )
        )
        #expect(throws: VaultConnectionConfigurationError.sharedWithWikiOrigin) {
            _ = try VaultWorkspaceModel.resolveConnection(from: overlappingCanister).get()
        }
    }

    @MainActor
    @Test func filtersByCategoryTagAndDomainAndSupportsCRUDAndLock() async throws {
        let model = VaultWorkspaceModel.preview()
        #expect(model.isUnlocked)
        #expect(model.items.count == 3)
        #expect(model.itemCount(for: .logins) == 2)
        #expect(model.itemCount(for: .twoFactor) == 1)
        #expect(model.itemCount(for: .notes) == 1)
        #expect(model.itemCount(for: .favorites) == 2)

        model.selectedCategory = .twoFactor
        #expect(model.filteredItems.map(\.title) == ["GitHub"])

        model.selectedCategory = .all
        model.searchQuery = "gist.github.com"
        #expect(model.filteredItems.map(\.title) == ["GitHub"])

        model.searchQuery = ""
        model.selectedTag = "ops"
        #expect(model.filteredItems.map(\.title) == ["SSH & Recovery Checklist"])
        model.selectedTag = nil

        // Create a new login with custom fields and TOTP.
        let newID = try await model.saveCredential(
            existing: nil,
            title: "Cloudflare",
            record: VaultCredentialRecord(
                label: "Cloudflare",
                username: "ops@kinic.xyz",
                password: "Strong-Password-123!",
                url: "https://dash.cloudflare.com",
                urls: ["https://dash.cloudflare.com"],
                totp: "JBSWY3DPEHPK3PXP",
                notes: "DNS admin",
                customFields: [VaultCustomField(label: "Account ID", value: "acc-123", hidden: false)],
                favorite: true,
                tags: ["infra"]
            )
        )
        #expect(model.items.count == 4)
        let decrypted = try #require(try model.decryptItem(objectId: newID))
        #expect(decrypted.credential?.customFields.first?.value == "acc-123")
        #expect(decrypted.summary.domains == ["dash.cloudflare.com"])

        // Delete it and verify count drops.
        try await model.deleteItem(decrypted.summary)
        #expect(model.items.count == 3)

        // Lock clears in-memory items and blocks decryption.
        model.lock()
        #expect(!model.isUnlocked)
        #expect(model.items.isEmpty)
        #expect(throws: VaultWorkspaceError.locked) {
            _ = try model.decryptItem(objectId: newID)
        }
    }
}
