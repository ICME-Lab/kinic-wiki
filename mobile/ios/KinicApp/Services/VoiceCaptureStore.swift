// Where: mobile/ios/KinicApp/Services/VoiceCaptureStore.swift
// What: File-backed storage for unsynced voice drafts and device-local recordings.
// Why: A capture must survive authentication, network, and process failures without uploading audio.

import CryptoKit
import Foundation

struct VoiceCaptureStore: @unchecked Sendable {
    private static let directoryName = "voice-captures.v1"
    private let rootDirectory: URL
    private let fileManager: FileManager
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder

    init(rootDirectory: URL, fileManager: FileManager = .default) throws {
        self.rootDirectory = rootDirectory
        self.fileManager = fileManager
        encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        try createProtectedDirectory(rootDirectory)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var mutableRoot = rootDirectory
        try mutableRoot.setResourceValues(values)
    }

    static func live(fileManager: FileManager = .default) throws -> VoiceCaptureStore {
        let applicationSupport = try fileManager.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        return try VoiceCaptureStore(
            rootDirectory: applicationSupport.appending(path: directoryName, directoryHint: .isDirectory),
            fileManager: fileManager
        )
    }

    func load(scope: VoiceCaptureAccountScope) -> [VoiceCaptureDraft] {
        let directory = scopeDirectory(scope)
        let files = (try? fileManager.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: nil
        )) ?? []
        return files
            .filter { $0.pathExtension == "json" }
            .compactMap { fileURL in
                do {
                    let draft = try decoder.decode(VoiceCaptureDraft.self, from: Data(contentsOf: fileURL))
                    guard draft.scope == scope,
                          fileURL.deletingPathExtension().lastPathComponent == draft.id.uuidString.lowercased() else {
                        try quarantine(fileURL, scope: scope)
                        return nil
                    }
                    return draft
                } catch {
                    try? quarantine(fileURL, scope: scope)
                    return nil
                }
            }
            .sorted { left, right in
                if left.capturedAt == right.capturedAt {
                    return left.id.uuidString < right.id.uuidString
                }
                return left.capturedAt > right.capturedAt
            }
    }

    func save(_ draft: VoiceCaptureDraft) throws {
        let directory = scopeDirectory(draft.scope)
        try createProtectedDirectory(directory)
        let data = try encoder.encode(draft)
        try data.write(to: draftURL(draft.id, scope: draft.scope), options: .atomic)
    }

    func remove(_ draft: VoiceCaptureDraft, includingAudio: Bool = true) throws {
        let draftURL = draftURL(draft.id, scope: draft.scope)
        if fileManager.fileExists(atPath: draftURL.path) {
            try fileManager.removeItem(at: draftURL)
        }
        if includingAudio, let audioFilename = draft.audioFilename {
            let audioURL = audioURL(filename: audioFilename, scope: draft.scope)
            if fileManager.fileExists(atPath: audioURL.path) {
                try fileManager.removeItem(at: audioURL)
            }
        }
    }

    func removeAudio(from draft: VoiceCaptureDraft) throws -> VoiceCaptureDraft {
        guard let audioFilename = draft.audioFilename else { return draft }
        let target = audioURL(filename: audioFilename, scope: draft.scope)
        if fileManager.fileExists(atPath: target.path) {
            try fileManager.removeItem(at: target)
        }
        var updated = draft
        updated.audioFilename = nil
        try save(updated)
        return updated
    }

    func removeAll(scope: VoiceCaptureAccountScope) throws {
        let directory = scopeDirectory(scope)
        guard fileManager.fileExists(atPath: directory.path) else { return }
        try fileManager.removeItem(at: directory)
    }

    func makeAudioURL(id: UUID, scope: VoiceCaptureAccountScope) throws -> URL {
        let directory = audioDirectory(scope)
        try createProtectedDirectory(directory)
        return directory.appending(path: "\(id.uuidString.lowercased()).m4a", directoryHint: .notDirectory)
    }

    func audioURL(for draft: VoiceCaptureDraft) -> URL? {
        guard let audioFilename = draft.audioFilename else { return nil }
        let url = audioURL(filename: audioFilename, scope: draft.scope)
        return fileManager.fileExists(atPath: url.path) ? url : nil
    }

    private func draftURL(_ id: UUID, scope: VoiceCaptureAccountScope) -> URL {
        scopeDirectory(scope).appending(path: "\(id.uuidString.lowercased()).json", directoryHint: .notDirectory)
    }

    private func audioURL(filename: String, scope: VoiceCaptureAccountScope) -> URL {
        audioDirectory(scope).appending(path: URL(fileURLWithPath: filename).lastPathComponent, directoryHint: .notDirectory)
    }

    private func audioDirectory(_ scope: VoiceCaptureAccountScope) -> URL {
        scopeDirectory(scope).appending(path: "Audio", directoryHint: .isDirectory)
    }

    private func scopeDirectory(_ scope: VoiceCaptureAccountScope) -> URL {
        rootDirectory.appending(path: Self.scopeKey(scope), directoryHint: .isDirectory)
    }

    private static func scopeKey(_ scope: VoiceCaptureAccountScope) -> String {
        switch scope {
        case .guest:
            return "guest"
        case let .principal(principal):
            let digest = SHA256.hash(data: Data(principal.utf8))
            return "principal-\(digest.map { String(format: "%02x", $0) }.joined())"
        }
    }

    private func quarantine(_ fileURL: URL, scope: VoiceCaptureAccountScope) throws {
        let directory = scopeDirectory(scope).appending(path: "Corrupt", directoryHint: .isDirectory)
        try createProtectedDirectory(directory)
        let destination = directory.appending(path: "\(UUID().uuidString.lowercased()).json", directoryHint: .notDirectory)
        try fileManager.moveItem(at: fileURL, to: destination)
    }

    private func createProtectedDirectory(_ directory: URL) throws {
        try fileManager.createDirectory(
            at: directory,
            withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
        )
    }
}
