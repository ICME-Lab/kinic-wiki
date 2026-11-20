import Foundation

public struct VaultCustomField: Codable, Equatable, Sendable {
    public let label: String
    public let value: String
    public let hidden: Bool?

    public init(label: String, value: String, hidden: Bool? = nil) {
        self.label = label
        self.value = value
        self.hidden = hidden
    }
}

public struct VaultCredentialRecord: Equatable, Sendable {
    public var label: String
    public var username: String
    public var password: String
    public var url: String
    public var urls: [String]
    public var totp: String
    public var notes: String
    public var customFields: [VaultCustomField]
    public var favorite: Bool
    public var tags: [String]

    public init(
        label: String = "",
        username: String = "",
        password: String = "",
        url: String = "",
        urls: [String] = [],
        totp: String = "",
        notes: String = "",
        customFields: [VaultCustomField] = [],
        favorite: Bool = false,
        tags: [String] = []
    ) {
        self.label = label
        self.username = username
        self.password = password
        self.url = url
        self.urls = urls
        self.totp = totp
        self.notes = notes
        self.customFields = customFields
        self.favorite = favorite
        self.tags = tags
    }
}

private struct CredentialWirePayload: Codable {
    var label: String?
    var username: String?
    var password: String?
    var URL: String?
    var url: String?
    var urls: [String]?
    var totp: String?
    var notes: String?
    var customFields: [VaultCustomField]?
    var favorite: Bool?
    var tags: [String]?
}

public enum VaultCredentialCodec {
    private static let blockedSchemes: Set<String> = [
        "javascript", "data", "vbscript", "blob", "file", "about", "mailto", "tel",
    ]

    public static func normalizeDomain(_ raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= 2048 else { return nil }

        if let colon = trimmed.firstIndex(of: ":") {
            let prefix = String(trimmed[..<colon]).lowercased()
            let validScheme = prefix.first?.isLetter == true && prefix.allSatisfy {
                $0.isLetter || $0.isNumber || $0 == "+" || $0 == "." || $0 == "-"
            }
            if validScheme {
                if blockedSchemes.contains(prefix) { return nil }
                if prefix != "http" && prefix != "https" && prefix != "android" && !trimmed.contains("://") {
                    return nil
                }
            }
        }

        var candidate = trimmed
        if !candidate.contains("://") {
            if candidate.rangeOfCharacter(from: .whitespacesAndNewlines) != nil { return nil }
            candidate = "https://\(candidate)"
        }

        guard let components = URLComponents(string: candidate),
              var host = components.host?.lowercased(),
              !host.isEmpty,
              host.utf16.count <= 255
        else {
            return nil
        }

        if host.hasSuffix(".") {
            host.removeLast()
        }
        guard !host.isEmpty else { return nil }
        if host != "localhost" && !host.contains(".") && !host.allSatisfy(\.isNumber) {
            return nil
        }
        return host
    }

    public static func extractDomains(_ urls: [String]) -> [String] {
        var seen = Set<String>()
        var result: [String] = []
        for url in urls {
            guard let domain = normalizeDomain(url), seen.insert(domain).inserted else { continue }
            result.append(domain)
            if result.count >= 32 { break }
        }
        return result
    }

    public static func matchesDomain(domains: [String]?, queryHost: String) -> Bool {
        guard let target = normalizeDomain(queryHost), let domains, !domains.isEmpty else {
            return false
        }
        return domains.contains { raw in
            let domain = raw.lowercased()
            return domain == target
                || target.hasSuffix(".\(domain)")
                || domain.hasSuffix(".\(target)")
        }
    }

    public static func parse(_ data: Data) -> VaultCredentialRecord {
        guard let payload = try? JSONDecoder().decode(CredentialWirePayload.self, from: data) else {
            let fallback = String(data: data, encoding: .utf8) ?? ""
            return VaultCredentialRecord(notes: fallback)
        }
        let primaryURL = payload.URL ?? payload.url ?? ""
        var seen = Set<String>()
        var urls: [String] = []
        for candidate in [primaryURL] + (payload.urls ?? []) {
            let trimmed = candidate.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty, seen.insert(trimmed).inserted else { continue }
            urls.append(trimmed)
            if urls.count >= 32 { break }
        }
        return VaultCredentialRecord(
            label: payload.label ?? "",
            username: payload.username ?? "",
            password: payload.password ?? "",
            url: primaryURL.isEmpty ? (urls.first ?? "") : primaryURL,
            urls: urls,
            totp: payload.totp ?? "",
            notes: payload.notes ?? "",
            customFields: payload.customFields ?? [],
            favorite: payload.favorite ?? false,
            tags: payload.tags ?? []
        )
    }

    public static func serialize(_ record: VaultCredentialRecord) throws -> Data {
        var seen = Set<String>()
        var urls: [String] = []
        for candidate in [record.url] + record.urls {
            let trimmed = candidate.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty, seen.insert(trimmed).inserted else { continue }
            urls.append(trimmed)
            if urls.count >= 32 { break }
        }
        let primary = record.url.trimmingCharacters(in: .whitespacesAndNewlines)
        let effectivePrimary = primary.isEmpty ? (urls.first ?? "") : primary
        let totp = record.totp.trimmingCharacters(in: .whitespacesAndNewlines)

        let wire = CredentialWirePayload(
            label: record.label,
            username: record.username,
            password: record.password,
            URL: effectivePrimary,
            url: nil,
            urls: (urls.count > 1 || (urls.count == 1 && urls[0] != effectivePrimary)) ? urls : nil,
            totp: totp.isEmpty ? nil : totp,
            notes: record.notes,
            customFields: record.customFields.isEmpty ? nil : record.customFields,
            favorite: record.favorite ? true : nil,
            tags: record.tags.isEmpty ? nil : record.tags
        )
        return try JSONEncoder().encode(wire)
    }

    public static func buildMetadata(title: String, record: VaultCredentialRecord) -> VaultMetadata {
        let domains = extractDomains([record.url] + record.urls)
        let trimmedUser = VaultMetadata.truncateText(record.username.trimmingCharacters(in: .whitespacesAndNewlines), limit: 256)
        let tags = record.tags.map { VaultMetadata.truncateText($0, limit: 64) }.filter { !$0.isEmpty }.prefix(32)
        let hasTotp = !record.totp.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return VaultMetadata(
            kind: .credential,
            title: VaultMetadata.truncateText(title, limit: 512),
            username: trimmedUser.isEmpty ? nil : trimmedUser,
            domains: domains.isEmpty ? nil : domains,
            hasTotp: hasTotp ? true : nil,
            favorite: record.favorite ? true : nil,
            tags: tags.isEmpty ? nil : Array(tags)
        )
    }
}
