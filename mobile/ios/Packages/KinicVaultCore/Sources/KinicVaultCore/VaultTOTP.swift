import CryptoKit
import Foundation

public enum VaultTOTPAlgorithm: String, Sendable, Equatable {
    case sha1 = "SHA-1"
    case sha256 = "SHA-256"
    case sha512 = "SHA-512"
}

public struct VaultTOTPConfig: Equatable, Sendable {
    public let secret: String
    public let algorithm: VaultTOTPAlgorithm
    public let digits: Int
    public let period: Int
    public let issuer: String?
    public let label: String?

    public init(
        secret: String,
        algorithm: VaultTOTPAlgorithm = .sha1,
        digits: Int = 6,
        period: Int = 30,
        issuer: String? = nil,
        label: String? = nil
    ) {
        self.secret = secret
        self.algorithm = algorithm
        self.digits = digits
        self.period = period
        self.issuer = issuer
        self.label = label
    }
}

public struct VaultTOTPCode: Equatable, Sendable {
    public let code: String
    public let remainingSeconds: Int
    public let period: Int
}

public enum VaultTOTP {
    private static let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")

    public static func decodeBase32(_ input: String) throws -> Data {
        let cleaned = input
            .uppercased()
            .filter { !$0.isWhitespace && $0 != "-" }
            .replacingOccurrences(of: "=", with: "")
        guard !cleaned.isEmpty else { throw VaultCryptoError.invalidTotpSecret }
        var bits = 0
        var value = 0
        var bytes: [UInt8] = []
        for ch in cleaned {
            guard let idx = alphabet.firstIndex(of: ch) else {
                throw VaultCryptoError.invalidTotpSecret
            }
            value = (value << 5) | idx
            bits += 5
            if bits >= 8 {
                bits -= 8
                bytes.append(UInt8((value >> bits) & 0xff))
            }
        }
        guard !bytes.isEmpty else { throw VaultCryptoError.invalidTotpSecret }
        return Data(bytes)
    }

    public static func parse(_ input: String) throws -> VaultTOTPConfig {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw VaultCryptoError.invalidTotpSecret }

        if trimmed.lowercased().hasPrefix("otpauth://") {
            guard let components = URLComponents(string: trimmed) else {
                throw VaultCryptoError.invalidTotpUri
            }
            guard components.host?.lowercased() == "totp" else {
                throw VaultCryptoError.unsupportedOtpType
            }
            let known: Set<String> = ["secret", "algorithm", "digits", "period", "issuer"]
            var query: [String: String] = [:]
            for item in components.queryItems ?? [] {
                let name = item.name.lowercased()
                guard known.contains(name) else { continue }
                guard query[name] == nil else { throw VaultCryptoError.invalidTotpUri }
                query[name] = item.value ?? ""
            }
            let secret = query["secret"]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            _ = try decodeBase32(secret)

            let algorithm: VaultTOTPAlgorithm
            if let algRaw = query["algorithm"]?.uppercased().filter({ $0.isLetter || $0.isNumber }) {
                switch algRaw {
                case "SHA1": algorithm = .sha1
                case "SHA256": algorithm = .sha256
                case "SHA512": algorithm = .sha512
                default: throw VaultCryptoError.unsupportedTotpAlgorithm
                }
            } else {
                algorithm = .sha1
            }

            let digits = try parseNumber(query["digits"], defaultValue: 6, error: .invalidTotpDigits)
            guard (6...8).contains(digits) else { throw VaultCryptoError.invalidTotpDigits }

            let period = try parseNumber(query["period"], defaultValue: 30, error: .invalidTotpPeriod)
            guard (1...300).contains(period) else { throw VaultCryptoError.invalidTotpPeriod }

            let label = components.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            return VaultTOTPConfig(
                secret: secret,
                algorithm: algorithm,
                digits: digits,
                period: period,
                issuer: query["issuer"],
                label: label.isEmpty ? nil : label
            )
        }

        _ = try decodeBase32(trimmed)
        return VaultTOTPConfig(secret: trimmed)
    }

    private static func parseNumber(_ raw: String?, defaultValue: Int, error: VaultCryptoError) throws -> Int {
        guard let raw else { return defaultValue }
        guard !raw.isEmpty, raw.utf8.allSatisfy({ (48...57).contains($0) }), let value = Int(raw) else { throw error }
        return value
    }

    public static func generate(
        input: String,
        now: Date = Date()
    ) throws -> VaultTOTPCode {
        try generate(config: try parse(input), now: now)
    }

    public static func generate(
        config: VaultTOTPConfig,
        now: Date = Date()
    ) throws -> VaultTOTPCode {
        guard (6...8).contains(config.digits) else { throw VaultCryptoError.invalidTotpDigits }
        guard (1...300).contains(config.period) else { throw VaultCryptoError.invalidTotpPeriod }
        let keyData = try decodeBase32(config.secret)
        let key = SymmetricKey(data: keyData)
        let epochSeconds = Int64(floor(now.timeIntervalSince1970))
        let counter = UInt64(bitPattern: epochSeconds / Int64(config.period))
        let elapsed = Int(((epochSeconds % Int64(config.period)) + Int64(config.period)) % Int64(config.period))
        let remaining = config.period - elapsed

        var counterBE = counter.bigEndian
        let counterData = Data(bytes: &counterBE, count: 8)

        let mac: [UInt8]
        switch config.algorithm {
        case .sha1:
            mac = Array(HMAC<Insecure.SHA1>.authenticationCode(for: counterData, using: key))
        case .sha256:
            mac = Array(HMAC<SHA256>.authenticationCode(for: counterData, using: key))
        case .sha512:
            mac = Array(HMAC<SHA512>.authenticationCode(for: counterData, using: key))
        }

        let offset = Int(mac[mac.count - 1] & 0x0f)
        let binary =
            (UInt32(mac[offset] & 0x7f) << 24)
            | (UInt32(mac[offset + 1]) << 16)
            | (UInt32(mac[offset + 2]) << 8)
            | UInt32(mac[offset + 3])
        var modulo: UInt32 = 1
        for _ in 0..<config.digits { modulo *= 10 }
        let code = String(format: "%0\(config.digits)u", binary % modulo)
        return VaultTOTPCode(code: code, remainingSeconds: remaining, period: config.period)
    }

    public static func formatCode(_ code: String) -> String {
        let digits = code.trimmingCharacters(in: .whitespacesAndNewlines)
        guard digits.count >= 6 else { return digits }
        let split = digits.count / 2
        let index = digits.index(digits.startIndex, offsetBy: split)
        return "\(digits[..<index]) \(digits[index...])"
    }
}
