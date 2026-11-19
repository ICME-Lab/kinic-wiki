import Foundation
import Security

public struct VaultPasswordOptions: Sendable {
    public var length: Int
    public var uppercase: Bool
    public var lowercase: Bool
    public var digits: Bool
    public var symbols: Bool
    public var excludeAmbiguous: Bool

    public init(
        length: Int = 20,
        uppercase: Bool = true,
        lowercase: Bool = true,
        digits: Bool = true,
        symbols: Bool = true,
        excludeAmbiguous: Bool = false
    ) {
        self.length = length
        self.uppercase = uppercase
        self.lowercase = lowercase
        self.digits = digits
        self.symbols = symbols
        self.excludeAmbiguous = excludeAmbiguous
    }
}

public enum VaultPasswordGenerator {
    private static let upper = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZ")
    private static let lower = Array("abcdefghijklmnopqrstuvwxyz")
    private static let digits = Array("0123456789")
    private static let symbols = Array("!@#$%^&*()-_=+[]{}|;:,.<>?")
    private static let ambiguous: Set<Character> = ["0", "O", "o", "1", "l", "I"]

    public static func generate(_ options: VaultPasswordOptions = VaultPasswordOptions()) throws -> String {
        let length = min(128, max(8, options.length))
        func filter(_ chars: [Character]) -> [Character] {
            options.excludeAmbiguous ? chars.filter { !ambiguous.contains($0) } : chars
        }
        var pools: [[Character]] = []
        if options.uppercase { pools.append(filter(upper)) }
        if options.lowercase { pools.append(filter(lower)) }
        if options.digits { pools.append(filter(digits)) }
        if options.symbols { pools.append(filter(symbols)) }
        if pools.isEmpty { pools.append(filter(lower)) }

        let combined = pools.flatMap { $0 }
        var chars: [Character] = []
        chars.reserveCapacity(length)
        for pool in pools where chars.count < length {
            chars.append(pool[try randomIndex(pool.count)])
        }
        while chars.count < length {
            chars.append(combined[try randomIndex(combined.count)])
        }
        for i in stride(from: chars.count - 1, through: 1, by: -1) {
            let j = try randomIndex(i + 1)
            chars.swapAt(i, j)
        }
        return String(chars)
    }

    private static func randomIndex(_ upperBound: Int) throws -> Int {
        guard upperBound > 0 else { throw VaultCryptoError.invalidInput }
        if upperBound == 1 { return 0 }
        let bound = UInt32(upperBound)
        let limit = (UInt32.max / bound) * bound
        var value: UInt32 = 0
        while true {
            let status = SecRandomCopyBytes(kSecRandomDefault, MemoryLayout<UInt32>.size, &value)
            guard status == errSecSuccess else { throw VaultCryptoError.randomFailure }
            if value < limit {
                return Int(value % bound)
            }
        }
    }
}
