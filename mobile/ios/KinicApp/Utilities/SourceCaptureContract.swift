import Foundation

enum SourceCaptureContract {
    static let requestPrefix = "/Sources/source-capture-requests/"

    static func isSafeRequestId(_ value: String) -> Bool {
        let bytes = Array(value.utf8)
        guard !bytes.isEmpty,
              bytes.count <= 128,
              isASCIIAlphanumeric(bytes[0]),
              !value.contains("..") else {
            return false
        }
        return bytes.allSatisfy {
            isASCIIAlphanumeric($0) || $0 == 46 || $0 == 95 || $0 == 45
        }
    }

    static func requestPath(for requestId: String) -> String? {
        guard isSafeRequestId(requestId) else {
            return nil
        }
        return "\(requestPrefix)\(requestId).md"
    }

    static func requestId(from path: String) -> String? {
        guard path.hasPrefix(requestPrefix), path.hasSuffix(".md") else {
            return nil
        }
        let start = path.index(path.startIndex, offsetBy: requestPrefix.count)
        let end = path.index(path.endIndex, offsetBy: -3)
        let requestId = String(path[start..<end])
        return isSafeRequestId(requestId) ? requestId : nil
    }

    static func isRequestPath(_ path: String) -> Bool {
        requestId(from: path) != nil
    }

    private static func isASCIIAlphanumeric(_ byte: UInt8) -> Bool {
        (byte >= 48 && byte <= 57)
            || (byte >= 65 && byte <= 90)
            || (byte >= 97 && byte <= 122)
    }
}
