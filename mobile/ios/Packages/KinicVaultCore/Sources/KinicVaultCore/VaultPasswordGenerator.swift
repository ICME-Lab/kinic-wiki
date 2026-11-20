import Foundation
import Security

public struct VaultPasswordOptions: Equatable, Sendable {
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

public struct VaultPassphraseOptions: Equatable, Sendable {
    public var words: Int
    public var separator: String
    public var capitalize: Bool
    public var includeNumber: Bool

    public init(
        words: Int = 5,
        separator: String = "-",
        capitalize: Bool = true,
        includeNumber: Bool = true
    ) {
        self.words = words
        self.separator = separator
        self.capitalize = capitalize
        self.includeNumber = includeNumber
    }
}

public enum VaultPasswordStrengthLevel: String, Equatable, Sendable {
    case weak
    case fair
    case strong
    case veryStrong = "very-strong"

    public var displayName: String {
        switch self {
        case .weak: "Weak"
        case .fair: "Fair"
        case .strong: "Strong"
        case .veryStrong: "Very strong"
        }
    }
}

public struct VaultPasswordStrength: Equatable, Sendable {
    public let level: VaultPasswordStrengthLevel
    public let entropyBits: Double

    public init(level: VaultPasswordStrengthLevel, entropyBits: Double) {
        self.level = level
        self.entropyBits = entropyBits
    }
}

public enum VaultPasswordGenerator {
    private static let upper = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZ")
    private static let lower = Array("abcdefghijklmnopqrstuvwxyz")
    private static let digits = Array("0123456789")
    private static let symbols = Array("!@#$%^&*()-_=+[]{}|;:,.<>?")
    private static let ambiguous: Set<Character> = ["0", "O", "o", "1", "l", "I"]

    // Compact, unambiguous high-readability English wordlist (256 words = 8 bits/word),
    // matching packages/vault-crypto/src/password-generator.ts.
    private static let wordlist: [String] = [
        "acorn", "agate", "alder", "amber", "anchor", "anise", "apple", "apron",
        "arbor", "arrow", "aspen", "atlas", "attic", "audio", "autumn", "avocado",
        "badge", "baker", "bamboo", "banjo", "barley", "basil", "basin", "beacon",
        "beaver", "berry", "birch", "bison", "blade", "bloom", "bluff", "boulder",
        "branch", "breeze", "bridge", "brook", "brush", "buckle", "butter", "cabin",
        "cactus", "cairn", "camera", "candle", "canopy", "canyon", "carbon", "carpet",
        "carrot", "castle", "cedar", "celery", "chalk", "channel", "cherry", "chisel",
        "cider", "cinder", "citrus", "clasp", "clover", "cobalt", "coffee", "comet",
        "compass", "copper", "coral", "cotton", "cradle", "crater", "creek", "crest",
        "crimson", "crown", "crystal", "cypress", "dagger", "daisy", "dancer", "dawn",
        "delta", "desert", "diamond", "dolphin", "domino", "dragon", "drift", "drizzle",
        "eagle", "earth", "eclipse", "ember", "emerald", "engine", "falcon", "feather",
        "fennel", "fern", "fiddle", "field", "figure", "finch", "fjord", "flame",
        "flint", "flora", "flute", "forest", "fossil", "fountain", "frost", "galaxy",
        "garden", "garlic", "garnet", "geyser", "ginger", "glacier", "glade", "glider",
        "granite", "grape", "gravel", "griffin", "grove", "guitar", "harbor", "harvest",
        "hazel", "heather", "helmet", "heron", "hickory", "hilltop", "hollow", "honey",
        "horizon", "iceberg", "indigo", "island", "ivory", "jacket", "jade", "jasmine",
        "jasper", "jigsaw", "juniper", "kayak", "kelp", "kernel", "kettle", "kestrel",
        "lantern", "larch", "laurel", "lavender", "lemon", "lichen", "lilac", "linden",
        "lizard", "lotus", "lumber", "magnet", "magpie", "mango", "maple", "marble",
        "marina", "meadow", "melon", "mercury", "meteor", "mineral", "mint", "mirror",
        "monarch", "monkey", "monolith", "moon", "moss", "muffin", "mulberry", "nebula",
        "nectar", "needle", "nickel", "nimbus", "nutmeg", "oasis", "obsidian", "ocean",
        "ochre", "olive", "onyx", "opal", "orange", "orbit", "orchid", "oriole",
        "osprey", "otter", "oyster", "paddle", "palace", "panther", "papaya", "parcel",
        "parrot", "pebble", "pecan", "pelican", "pepper", "petrel", "pewter", "phoenix",
        "picnic", "pigeon", "pillar", "pine", "planet", "plaza", "plover", "plum",
        "pocket", "poplar", "portal", "prairie", "prism", "puffin", "pumpkin", "quartz",
        "quiver", "rabbit", "radish", "rainbow", "ranger", "raven", "redwood", "reef",
        "ribbon", "ridge", "ripple", "river", "robin", "rocket", "rosemary", "ruby",
        "saffron", "sage", "salmon", "sandal", "sapphire", "saturn", "scarlet", "summit",
    ]
    private static let wordlistSet = Set(wordlist)

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

    public static func generatePassphrase(_ options: VaultPassphraseOptions = VaultPassphraseOptions()) throws -> String {
        let count = min(10, max(3, options.words))
        var picked: [String] = []
        picked.reserveCapacity(count)
        for _ in 0..<count {
            var word = wordlist[try randomIndex(wordlist.count)]
            if options.capitalize, let first = word.first {
                word = first.uppercased() + word.dropFirst()
            }
            picked.append(word)
        }
        if options.includeNumber {
            let idx = try randomIndex(picked.count)
            let number = try randomIndex(100)
            picked[idx] = "\(picked[idx])\(number)"
        }
        return picked.joined(separator: options.separator)
    }

    /// Entropy of the generator's random choices. Formatting adds no randomness.
    public static func estimatePassphraseStrength(_ options: VaultPassphraseOptions = VaultPassphraseOptions()) -> VaultPasswordStrength {
        let count = min(10, max(3, options.words))
        let wordEntropy = Double(count) * log2(Double(wordlist.count))
        let numberEntropy = options.includeNumber ? log2(Double(count * 100)) : 0
        return strengthFromEntropy(wordEntropy + numberEntropy)
    }

    public static func estimateStrength(_ password: String) -> VaultPasswordStrength {
        guard !password.isEmpty else {
            return VaultPasswordStrength(level: .weak, entropyBits: 0)
        }

        // Recognize phrases produced by the generator (with common separators) even after saving.
        for separator in ["-", ".", "_", " "] {
            let parts = password.components(separatedBy: separator)
            if parts.count >= 3 && parts.count <= 10 {
                var numbered = 0
                var allWordsValid = true
                for part in parts {
                    guard let (word, hasNumber) = splitWordAndOptionalSuffix(part),
                          wordlistSet.contains(word.lowercased())
                    else {
                        allWordsValid = false
                        break
                    }
                    if hasNumber { numbered += 1 }
                }
                if allWordsValid && numbered <= 1 {
                    return estimatePassphraseStrength(
                        VaultPassphraseOptions(words: parts.count, separator: separator, includeNumber: numbered == 1)
                    )
                }
            }
        }

        var hasLower = false
        var hasUpper = false
        var hasDigit = false
        var hasSymbol = false
        for scalar in password.unicodeScalars {
            if ("a"..."z").contains(scalar) { hasLower = true }
            else if ("A"..."Z").contains(scalar) { hasUpper = true }
            else if ("0"..."9").contains(scalar) { hasDigit = true }
            else { hasSymbol = true }
        }
        var poolSize = 0
        if hasLower { poolSize += 26 }
        if hasUpper { poolSize += 26 }
        if hasDigit { poolSize += 10 }
        if hasSymbol { poolSize += 32 }
        if poolSize == 0 { poolSize = 1 }

        let uniqueRatio = Double(Set(password).count) / Double(password.count)
        let effectiveLength = Double(password.count) * (0.5 + 0.5 * uniqueRatio)
        let entropyBits = (effectiveLength * log2(Double(poolSize))).rounded()
        let strength = strengthFromEntropy(entropyBits)
        if password.count < 8 {
            return VaultPasswordStrength(level: .weak, entropyBits: strength.entropyBits)
        }
        return strength
    }

    private static func splitWordAndOptionalSuffix(_ part: String) -> (String, Bool)? {
        guard !part.isEmpty else { return nil }
        var letters = ""
        var digits = ""
        for ch in part {
            if ch.isASCII && ch.isLetter && digits.isEmpty {
                letters.append(ch)
            } else if ch.isASCII && ch.isNumber && !letters.isEmpty {
                digits.append(ch)
            } else {
                return nil
            }
        }
        guard !letters.isEmpty, digits.count <= 2 else { return nil }
        return (letters, !digits.isEmpty)
    }

    private static func strengthFromEntropy(_ entropyBits: Double) -> VaultPasswordStrength {
        let level: VaultPasswordStrengthLevel =
            entropyBits < 40 ? .weak :
            entropyBits < 60 ? .fair :
            entropyBits < 85 ? .strong : .veryStrong
        return VaultPasswordStrength(level: level, entropyBits: entropyBits)
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
